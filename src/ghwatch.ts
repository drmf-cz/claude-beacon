import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * GitHub Events API watcher — no webhook server, no tunnel required.
 *
 * Uses `gh` CLI auth (run `gh auth login` once) or GITHUB_TOKEN to poll
 * /repos/{owner}/{repo}/events, respecting ETag + X-Poll-Interval headers
 * so requests are efficient and rate-limit-safe.
 *
 * Usage:
 *   WATCH_REPOS=owner/repo1,owner/repo2 bun run src/ghwatch.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, parseWorkflowEvent } from "./server.js";
import type { GitHubWebhookPayload } from "./types.js";

const log = (...args: unknown[]) => console.error("[github-ci watch]", ...args);

// ── Auth ─────────────────────────────────────────────────────────────────────

async function resolveToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const token = (await new Response(proc.stdout).text()).trim();
  if (!token) {
    throw new Error(
      "No GITHUB_TOKEN set and `gh auth token` returned empty — run `gh auth login` first",
    );
  }
  return token;
}

// ── GitHub Events API ─────────────────────────────────────────────────────────

interface GitHubEvent {
  id: string;
  type: string;
  repo: { name: string };
  payload: {
    action?: string;
    workflow_run?: GitHubWebhookPayload["workflow_run"];
    sender?: GitHubWebhookPayload["sender"];
  };
}

interface FetchResult {
  etag: string | undefined;
  /** Milliseconds to wait before next poll (from X-Poll-Interval header). */
  pollInterval: number;
  /** null when server returned 304 Not Modified. */
  events: GitHubEvent[] | null;
}

async function fetchEvents(
  repo: string,
  token: string,
  etag: string | undefined,
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (etag) headers["If-None-Match"] = etag;

  const resp = await fetch(`https://api.github.com/repos/${repo}/events?per_page=30`, { headers });

  const newEtag = resp.headers.get("ETag") ?? undefined;
  const pollInterval = Number.parseInt(resp.headers.get("X-Poll-Interval") ?? "60", 10) * 1000;

  if (resp.status === 304) return { etag: newEtag, pollInterval, events: null };

  if (!resp.ok) {
    log(`Events API ${resp.status} for ${repo}`);
    return { etag: newEtag, pollInterval, events: null };
  }

  return { etag: newEtag, pollInterval, events: (await resp.json()) as GitHubEvent[] };
}

// ── Watcher ──────────────────────────────────────────────────────────────────

async function processRepo(
  repo: string,
  token: string,
  mcp: McpServer,
  seen: Set<string>,
  etags: Map<string, string | undefined>,
): Promise<number> {
  const result = await fetchEvents(repo, token, etags.get(repo));
  if (result.etag !== undefined) etags.set(repo, result.etag);

  for (const event of result.events ?? []) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);

    if (event.type !== "WorkflowRunEvent" || event.payload.action !== "completed") {
      continue;
    }

    const payload: GitHubWebhookPayload = {
      action: "completed",
      repository: { full_name: event.repo.name },
      sender: event.payload.sender ?? { login: "unknown" },
      ...(event.payload.workflow_run ? { workflow_run: event.payload.workflow_run } : {}),
    };

    const notification = parseWorkflowEvent("workflow_run", payload);
    if (!notification) continue;

    log(`→ ${notification.summary.slice(0, 100)}`);
    try {
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: {
          channel: "github-ci",
          type: "ci_result",
          summary: notification.summary,
          meta: notification.meta,
        },
      });
    } catch (err) {
      log("Failed to send notification:", err);
    }
  }

  return result.pollInterval;
}

export function startWatcher(repos: string[], token: string, mcp: McpServer): void {
  const seen = new Set<string>();
  const etags = new Map<string, string | undefined>();

  async function seed(): Promise<void> {
    log(`Seeding existing events for ${repos.join(", ")}...`);
    for (const repo of repos) {
      const result = await fetchEvents(repo, token, undefined);
      if (result.etag !== undefined) etags.set(repo, result.etag);
      for (const e of result.events ?? []) seen.add(e.id);
      log(`  ${repo}: seeded ${result.events?.length ?? 0} events`);
    }
    log("Seed complete — watching for new completed workflow runs");
  }

  async function scheduleRepo(repo: string): Promise<void> {
    const pollInterval = await processRepo(repo, token, mcp, seen, etags);
    setTimeout(() => scheduleRepo(repo), pollInterval);
  }

  void seed().then(() => {
    for (const repo of repos) void scheduleRepo(repo);
  });
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

const token = await resolveToken();

const repos = (process.env.WATCH_REPOS ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

if (repos.length === 0) {
  console.error("ERROR: WATCH_REPOS must be set (e.g. WATCH_REPOS=owner/repo1,owner/repo2)");
  process.exit(1);
}

const mcp = createMcpServer();
const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP channel connected to Claude Code");

startWatcher(repos, token, mcp);
