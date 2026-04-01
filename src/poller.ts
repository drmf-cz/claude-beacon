import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseWorkflowEvent } from "./server.js";
import type { GitHubWebhookPayload } from "./types.js";

const log = (...args: unknown[]) => console.error("[github-ci poller]", ...args);

interface RunRecord {
  id: number;
  conclusion: string | null;
  updated_at: string;
}

// Track last-seen run IDs per repo to avoid re-notifying
const seen = new Map<string, Set<number>>();

async function fetchLatestRuns(
  owner: string,
  repo: string,
  token: string,
): Promise<RunRecord[]> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=10&status=completed`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!resp.ok) {
    log(`GitHub API error for ${owner}/${repo}: ${resp.status} ${resp.statusText}`);
    return [];
  }

  const data = (await resp.json()) as { workflow_runs?: RunRecord[] };
  return data.workflow_runs ?? [];
}

async function fetchRunDetails(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<GitHubWebhookPayload | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!resp.ok) return null;

  const run = await resp.json();
  return {
    action: "completed",
    repository: { full_name: `${owner}/${repo}` },
    sender: { login: run.triggering_actor?.login ?? "unknown" },
    workflow_run: run,
  } as GitHubWebhookPayload;
}

async function pollRepo(
  owner: string,
  repo: string,
  token: string,
  mcp: McpServer,
): Promise<void> {
  const key = `${owner}/${repo}`;
  if (!seen.has(key)) seen.set(key, new Set());
  const seenIds = seen.get(key)!;

  const runs = await fetchLatestRuns(owner, repo, token);

  for (const run of runs) {
    if (seenIds.has(run.id)) continue;
    seenIds.add(run.id);

    // Skip runs without a conclusion (still in progress)
    if (!run.conclusion) continue;

    const payload = await fetchRunDetails(owner, repo, run.id, token);
    if (!payload) continue;

    const notification = parseWorkflowEvent("workflow_run", payload);
    if (!notification) continue;

    try {
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: { content: notification.summary, meta: notification.meta },
      });
      log(`Notified: ${notification.meta.status} — ${key} run #${run.id}`);
    } catch (err) {
      log("Failed to send notification:", err);
    }
  }
}

export function startPoller(
  repos: string[], // ["owner/repo", ...]
  token: string,
  mcp: McpServer,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  log(`Polling ${repos.join(", ")} every ${intervalMs / 1000}s`);

  // Seed seen IDs on first run (don't notify for pre-existing runs)
  const seed = async () => {
    for (const repo of repos) {
      const [owner, name] = repo.split("/");
      if (!owner || !name) continue;
      const runs = await fetchLatestRuns(owner, name, token);
      const key = `${owner}/${name}`;
      seen.set(key, new Set(runs.map((r) => r.id)));
      log(`Seeded ${runs.length} existing runs for ${key}`);
    }
  };

  seed().then(() => {
    log("Seed complete — watching for new completed runs");
  });

  return setInterval(async () => {
    for (const repo of repos) {
      const [owner, name] = repo.split("/");
      if (!owner || !name) continue;
      await pollRepo(owner, name, token, mcp).catch((e) =>
        log(`Poll error for ${repo}:`, e),
      );
    }
  }, intervalMs);
}
