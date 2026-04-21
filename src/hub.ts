/**
 * Hub server — company-wide multi-user entry point.
 *
 * claude-beacon-hub extends the mux with multi-tenant features:
 *   - Bearer token authentication per user (pre-shared, admin-configured in YAML)
 *   - Events routed by PR author → the author's registered Claude Code sessions (Tier 0)
 *   - Per-user skill config embedded into notification instructions
 *   - Anthropic SDK fallback worker: when a user's sessions are offline or unclaimed for
 *     too long, Claude handles the work server-side and posts a PR comment summary
 *
 * Exposes two HTTP endpoints:
 *   :9443  — GitHub webhook receiver (internet-facing via GitHub App webhook URL)
 *   :9444  — MCP over Streamable HTTP (expose via HTTPS reverse proxy; Bearer auth required)
 *
 * Each developer registers their Claude Code with:
 *   claude mcp add --transport http claude-beacon https://beacon.company.com/mcp
 * Their personal Bearer token must be in the Authorization header (set in MCP client config).
 *
 * Environment variables (can be placed in a .env file — Bun loads it automatically):
 *   GITHUB_WEBHOOK_SECRET  required  HMAC secret for webhook verification
 *   GITHUB_TOKEN           required  PAT for log fetching and PR status checks
 *   ANTHROPIC_API_KEY      optional  Required when any user has fallback.enabled: true
 *   WEBHOOK_PORT           optional  Webhook receiver port (default: 9443)
 *   MCP_PORT               optional  MCP HTTP port (default: 9444)
 */

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { parse } from "yaml";
import { z } from "zod";
import type { Config, HubConfig, HubUserBehavior, HubUserProfile } from "./config.js";
import { DEFAULT_CONFIG, loadHubConfig, resolveUserConfig } from "./config.js";
import type { NotifyFn, RoutingKey } from "./server.js";
import { createMcpServer, sendChannelNotification, startWebhookServer } from "./server.js";
import { loadUniqueFilter, openFilterStore, saveFilter } from "./store.js";
import type { CINotification } from "./types.js";

const log = (...args: unknown[]) =>
  console.error(`[github-ci:hub] ${new Date().toISOString().slice(11, 23)}`, ...args);

// ── .env loader ───────────────────────────────────────────────────────────────
// Bun auto-loads .env only from the working directory. When running the compiled
// binary from a different directory, env vars may not be set. This function loads
// .env from next to the config file as a fallback (existing env vars are NOT
// overwritten, so shell exports always take precedence).
export function loadDotEnv(configPath: string): void {
  const envPath = resolve(dirname(configPath), ".env");
  let content: string;
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    return; // .env next to config is optional
  }
  let loaded = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key || key in process.env) continue; // never overwrite existing env vars
    const raw = line.slice(eqIdx + 1).trim();
    // Strip optional surrounding quotes (single or double)
    const val = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
    process.env[key] = val;
    loaded++;
  }
  if (loaded > 0) {
    log(`Loaded ${loaded} variable(s) from ${envPath}`);
  }
}

// ── Module-level mutable state ────────────────────────────────────────────────
// Declared here so session-factory closures can reference them at call time.
// All are populated by the CLI setup block at the bottom before any session connects.

let config: Config = DEFAULT_CONFIG;
let hubConfig: HubConfig = {
  users: [],
  fallback: {
    enabled: false,
    timeout_ms: 900_000,
    model: "claude-sonnet-4-6",
    notify_via_pr_comment: true,
  },
};
let tokenMap: Map<string, HubUserProfile> = new Map();
let fallbackWorker: FallbackWorker;

// ── Claim file helpers ────────────────────────────────────────────────────────

const CLAIM_FILE = join(homedir(), ".claude", "beacon-active-claim");

function writeClaimFile(claimKey: string): void {
  try {
    writeFileSync(CLAIM_FILE, claimKey, "utf8");
  } catch {
    // Non-fatal
  }
}

function deleteClaimFile(): void {
  try {
    rmSync(CLAIM_FILE, { force: true });
  } catch {
    // Non-fatal
  }
}

// ── Notification event store ──────────────────────────────────────────────────

class NotificationEventStore implements EventStore {
  private events = new Map<string, { streamId: string; message: unknown }>();

  async storeEvent(streamId: string, message: unknown): Promise<string> {
    const id = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.events.set(id, { streamId, message });
    log(
      `[sse] no active stream — buffered event ${id.slice(-8)} (total buffered: ${this.events.size})`,
    );
    return id;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (id: string, msg: unknown) => Promise<void> },
  ): Promise<string> {
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    // New or unknown SSE connection — replay all buffered events for this session.
    // Each NotificationEventStore is scoped to one session, so replaying all is safe.
    if (!lastEventId || !this.events.has(lastEventId)) {
      if (sorted.length > 0) {
        log(`[sse] replaying ${sorted.length} buffered event(s) to new SSE connection`);
      }
      for (const [id, { message }] of sorted) {
        await send(id, message);
      }
      const last = sorted[sorted.length - 1];
      return last ? (last[0].split("_")[0] ?? "") : "";
    }

    // Resume from a known event ID — skip everything up to and including it.
    const streamId = lastEventId.split("_")[0] ?? "";
    let found = false;
    for (const [id, { streamId: sid, message }] of sorted) {
      if (sid !== streamId) continue;
      if (id === lastEventId) {
        found = true;
        continue;
      }
      if (found) await send(id, message);
    }
    return streamId;
  }
}

// ── Session registry ──────────────────────────────────────────────────────────

interface HubSessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  /** GitHub login of the authenticated user — derived from Bearer token, immutable. */
  github_username: string;
  repo: string | null;
  branch: string | null;
  label: string | null;
  worktree_path: string | null;
  lastActivityAt: number;
  /** Per-session behavior override set via the set_behavior MCP tool. Highest priority. */
  behavior?: Partial<HubUserBehavior>;
}

const sessions = new Map<string, HubSessionEntry>();
/** Secondary index: github_username → Set<sessionId> for O(1) author-based routing. */
const userSessions = new Map<string, Set<string>>();

function addUserSession(username: string, sessionId: string): void {
  let ids = userSessions.get(username);
  if (!ids) {
    ids = new Set();
    userSessions.set(username, ids);
  }
  ids.add(sessionId);
}

function removeUserSession(username: string, sessionId: string): void {
  const ids = userSessions.get(username);
  if (!ids) return;
  ids.delete(sessionId);
  if (ids.size === 0) userSessions.delete(username);
}

// ── Work-context claims ───────────────────────────────────────────────────────

interface WorkClaim {
  sessionId: string;
  label: string | null;
  expiresAt: number;
}

const workClaims = new Map<string, WorkClaim>();

setInterval(() => {
  const now = Date.now();
  for (const [k, c] of workClaims) {
    if (now > c.expiresAt) {
      workClaims.delete(k);
      deleteClaimFile();
      log(`Claim expired: ${k}`);
      const ownerSession = sessions.get(c.sessionId);
      if (ownerSession) {
        sendStatusLine(ownerSession.server, buildStatusText(ownerSession)).catch(() => {});
      }
    }
  }
}, 60_000).unref();

function claimKeyFor(routing: RoutingKey): string {
  return routing.branch ? `${routing.repo}:${routing.branch}` : `${routing.repo}:*`;
}

// ── Pre-registration notification queue ──────────────────────────────────────

interface PendingNotification {
  notification: CINotification;
  routing: RoutingKey;
  receivedAt: number;
}

const pendingByRepo = new Map<string, PendingNotification[]>();
const MAX_PENDING_REPOS = 100;
const MAX_PENDING_PER_REPO = 50;

function enqueuePending(routing: RoutingKey, notification: CINotification): void {
  const key = routing.repo ?? "*";
  const now = Date.now();
  if (!pendingByRepo.has(key) && pendingByRepo.size >= MAX_PENDING_REPOS) {
    const oldest = pendingByRepo.keys().next().value;
    if (oldest !== undefined) pendingByRepo.delete(oldest);
  }
  const existing = (pendingByRepo.get(key) ?? []).filter(
    (n) => now - n.receivedAt < config.server.pending_ttl_ms,
  );
  if (existing.length >= MAX_PENDING_PER_REPO) existing.shift();
  existing.push({ notification, routing, receivedAt: now });
  pendingByRepo.set(key, existing);
  log(
    `Queued for replay (no session): ${routing.repo}@${routing.branch ?? "*"} — queue depth: ${existing.length}`,
  );
}

async function flushPendingToSession(repo: string | null, session: HubSessionEntry): Promise<void> {
  const keys = repo !== null ? [repo] : [...pendingByRepo.keys()];
  const now = Date.now();
  for (const key of keys) {
    const pending = pendingByRepo.get(key);
    if (!pending || pending.length === 0) continue;
    const fresh = pending.filter((n) => now - n.receivedAt < config.server.pending_ttl_ms);
    if (fresh.length === 0) {
      pendingByRepo.delete(key);
      continue;
    }
    log(`Flushing ${fresh.length} queued notification(s) for ${key} to ${session.github_username}`);
    let anyDelivered = false;
    for (const { notification, routing } of fresh) {
      const claimKey = claimKeyFor(routing);
      const enriched = enrichNotification(notification, claimKey, "normal");
      try {
        await sendChannelNotification(session.server, enriched);
        anyDelivered = true;
      } catch (err) {
        log(`Failed to flush pending notification for ${key}:`, err);
      }
    }
    if (anyDelivered) pendingByRepo.delete(key);
  }
}

// ── Session TTL ───────────────────────────────────────────────────────────────

setInterval(
  () => {
    const ttl = config.server.session_idle_ttl_ms;
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivityAt > ttl) {
        removeUserSession(session.github_username, id);
        sessions.delete(id);
        log(
          `Session ${id.slice(0, 8)} (${session.github_username}) idle >${Math.round(ttl / 60_000)}m — removed (total: ${sessions.size})`,
        );
        for (const [k, c] of workClaims) {
          if (c.sessionId === id) {
            workClaims.delete(k);
            log(`Stale claim cleared: ${k} (session was idle)`);
          }
        }
        // Close transport so Claude Code gets a clean disconnect and reconnects.
        session.transport.close().catch(() => {});
      }
    }
    if (sessions.size > 0) {
      const summary = [...sessions.entries()]
        .map(
          ([id, s]) =>
            `${id.slice(0, 8)}(${s.github_username}) ${s.repo ?? "*"}@${s.branch ?? "*"} idle=${Math.round((now - s.lastActivityAt) / 60_000)}m`,
        )
        .join(", ");
      log(`Active sessions [${sessions.size}]: ${summary}`);
    }
  },
  5 * 60 * 1000,
).unref();

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Validate a Bearer token from the Authorization header against registered users.
 * Returns the matching UserProfile, or null if the token is missing or invalid.
 */
export function bearerAuth(req: Request, map: Map<string, HubUserProfile>): HubUserProfile | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match?.[1]) return null;
  return map.get(match[1]) ?? null;
}

// ── Routing ───────────────────────────────────────────────────────────────────

/**
 * Four-tier session selection:
 *
 * Tier 0 (author match — hub-only): if the event has a known pr_author who is a
 *   registered hub user, limit candidates to that user's sessions; then apply
 *   Tier 1+2 repo+branch matching within that pool.
 *
 * Tier 1+2: sessions matching by repo AND (exact branch OR wildcard branch).
 *   Applied to ALL sessions when Tier 0 finds no candidates.
 *
 * Tier 3: catch-all — any session for the same repo, when Tier 1+2 is empty.
 *
 * Returns empty array when no sessions are registered at all (triggers fallback).
 */
export function selectHubRecipients(
  routing: RoutingKey,
  allSessions: Map<string, HubSessionEntry>,
  allUserSessions: Map<string, Set<string>>,
): { recipients: HubSessionEntry[]; mode: "normal" | "catchall" } {
  const forRepo = (s: HubSessionEntry) => s.repo === null || s.repo === routing.repo;

  // Tier 0: restrict candidate pool to the event author's sessions
  const authorUsername = routing.pr_author ?? null;
  const authorIds = authorUsername ? (allUserSessions.get(authorUsername) ?? null) : null;
  const candidatePool: HubSessionEntry[] =
    authorIds !== null
      ? [...authorIds]
          .map((id) => allSessions.get(id))
          .filter((s): s is HubSessionEntry => s !== undefined)
      : [...allSessions.values()];

  // Tier 1+2: repo + branch match within candidate pool
  const primary = candidatePool.filter(
    (s) =>
      forRepo(s) && (s.branch === null || routing.branch === null || s.branch === routing.branch),
  );

  if (primary.length > 0) {
    const sorted = [
      ...primary.filter((s) => routing.branch !== null && s.branch === routing.branch),
      ...primary.filter((s) => !(routing.branch !== null && s.branch === routing.branch)),
    ];
    return { recipients: sorted, mode: "normal" };
  }

  // Tier 3: catch-all — only sessions that opted into null-branch monitoring.
  // Sessions with a specific branch filter should NOT receive events for other branches
  // as a catch-all: they registered interest in one branch, not the whole repo.
  const forCatchall = (s: HubSessionEntry) => forRepo(s) && s.branch === null;
  const catchall = candidatePool.filter(forCatchall);
  if (catchall.length > 0) return { recipients: catchall, mode: "catchall" };

  // If Tier 0 had candidates but none matched — fall through to null-branch sessions globally
  if (authorIds !== null && candidatePool.length > 0) {
    return {
      recipients: [...allSessions.values()].filter(forCatchall),
      mode: "catchall",
    };
  }

  return { recipients: [], mode: "catchall" };
}

function enrichNotification(
  n: CINotification,
  claimKey: string,
  mode: "owned" | "normal" | "catchall",
): CINotification {
  const meta = { ...n.meta, claim_key: claimKey };
  if (mode === "owned") return { meta, summary: n.summary };

  const branch = n.meta.branch ?? n.meta.head_branch ?? null;
  const branchSlug = branch?.replace(/[^a-z0-9]/gi, "-") ?? "fix";

  const catchallHeader =
    mode === "catchall"
      ? [
          "⚠️  CATCH-ALL DELIVERY: no session is currently in the worktree for this branch.",
          "One of you must volunteer by claiming it and creating a worktree.",
          "",
        ]
      : [];

  const worktreeBlock = branch
    ? [
        `IF claim returns "ok":`,
        `  a) Your current branch IS "${branch}":`,
        `     → Fix here in your current directory`,
        `  b) Your current branch IS NOT "${branch}":`,
        `     → git worktree add /tmp/${branchSlug}-fix ${branchSlug}`,
        `     → Fix in that worktree, commit, push`,
        `     → Call release_claim("${claimKey}") when done`,
        `     → git worktree remove /tmp/${branchSlug}-fix`,
      ]
    : [
        `IF claim returns "ok": fix in your current directory.`,
        `Call release_claim("${claimKey}") when done.`,
      ];

  const claimBlock = [
    "",
    "─────────────────────────────────────────",
    ...catchallHeader,
    `BEFORE ACTING: call claim_notification("${claimKey}")`,
    '  "ok"           → you have the lock, continue',
    '  "already_owned"→ you already hold it (TTL extended); continue if still working',
    '  "conflict:X"   → session X claimed it, STOP immediately',
    '  "expired"      → STOP',
    "",
    ...worktreeBlock,
    "─────────────────────────────────────────",
  ].join("\n");

  return { meta, summary: n.summary + claimBlock };
}

// ── Fallback worker ───────────────────────────────────────────────────────────

function buildFallbackPrompt(
  notification: CINotification,
  profile: HubUserProfile,
  eventType: string,
): string {
  const skillOverride =
    profile.skills?.[eventType as keyof NonNullable<HubUserProfile["skills"]>] ?? "";
  const lines = [
    `You are acting as a fallback worker for GitHub user @${profile.github_username}, who has no active Claude Code sessions right now.`,
    "Execute the following GitHub CI/PR notification directive on their behalf:",
    "",
    notification.summary,
  ];
  if (skillOverride) {
    lines.push("", `Use the "${skillOverride}" skill during the execution phase.`);
  }
  return lines.join("\n");
}

interface FallbackPending {
  notification: CINotification;
  routing: RoutingKey;
  profile: HubUserProfile;
  eventType: string;
  timer: ReturnType<typeof setTimeout>;
}

export class FallbackWorker {
  private pending = new Map<string, FallbackPending>();
  private client: Anthropic | null = null;
  private cfg: HubConfig;

  constructor(cfg: HubConfig) {
    this.cfg = cfg;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    } else {
      // Warn only for users who have fallback enabled but no per-user or hub-wide API key
      const anyEnabledWithoutKey = cfg.users.some(
        (u) => (u.fallback?.enabled ?? cfg.fallback.enabled) && !u.fallback?.anthropic_api_key,
      );
      if (anyEnabledWithoutKey) {
        log(
          "WARNING: ANTHROPIC_API_KEY is not set but fallback is enabled for some users.",
          "Set ANTHROPIC_API_KEY in .env or configure fallback.anthropic_api_key per user.",
        );
      }
    }
  }

  /**
   * Start watching a notification. If no session claims the work within the
   * configured timeout, the Anthropic SDK fallback fires.
   */
  watch(
    claimKey: string,
    notification: CINotification,
    routing: RoutingKey,
    profile: HubUserProfile,
    eventType: string,
  ): void {
    const effectiveEnabled = profile.fallback?.enabled ?? this.cfg.fallback.enabled;
    if (!effectiveEnabled) return;
    // Proceed only if there is a usable API key (per-user key takes precedence over hub-wide client)
    if (!profile.fallback?.anthropic_api_key && !this.client) return;

    const timeoutMs = profile.fallback?.timeout_ms ?? this.cfg.fallback.timeout_ms;

    const timer = setTimeout(() => {
      const entry = this.pending.get(claimKey);
      if (!entry) return;
      this.pending.delete(claimKey);
      log(
        `Fallback worker firing for ${claimKey} (${profile.github_username} unresponsive after ${timeoutMs / 1000}s)`,
      );
      this.invoke(entry).catch((err) => log("Fallback worker error:", err));
    }, timeoutMs);

    // Don't prevent process exit
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }

    this.pending.set(claimKey, { notification, routing, profile, eventType, timer });
  }

  /** Cancel the fallback timer when a session claims the work. */
  cancel(claimKey: string): void {
    const entry = this.pending.get(claimKey);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(claimKey);
    log(`Fallback cancelled for ${claimKey} — session claimed the work`);
  }

  private async invoke(entry: FallbackPending): Promise<void> {
    const { notification, routing, profile, eventType } = entry;
    // Per-user key takes precedence; fall back to hub-wide client
    const client = profile.fallback?.anthropic_api_key
      ? new Anthropic({ apiKey: profile.fallback.anthropic_api_key })
      : this.client;
    if (!client) return;

    const prompt = buildFallbackPrompt(notification, profile, eventType);

    let resultText = "";
    try {
      const msg = await client.messages.create({
        model: this.cfg.fallback.model,
        max_tokens: 8096,
        messages: [{ role: "user", content: prompt }],
      });
      const first = msg.content[0];
      resultText = first?.type === "text" ? first.text : "(no text response)";
      log(`Fallback worker completed for ${routing.repo}@${routing.branch ?? "*"}`);
    } catch (err) {
      log("Fallback worker Anthropic API error:", err);
      resultText = `Fallback worker encountered an error: ${String(err)}`;
    }

    // Post PR comment if configured
    const prNumber = notification.meta.pr_number;
    if (this.cfg.fallback.notify_via_pr_comment && prNumber && routing.repo) {
      await this.postPRComment(routing.repo, prNumber, profile, resultText);
    }

    // Queue a summary notification for when the user reconnects
    const summaryNotification: CINotification = {
      summary: [
        `🤖 Fallback worker handled a notification while @${profile.github_username} was offline.`,
        `Repo: ${routing.repo} | Branch: ${routing.branch ?? "*"}`,
        "",
        "Summary of what was done:",
        resultText.slice(0, 2000),
        resultText.length > 2000 ? "\n[truncated — full response was posted as a PR comment]" : "",
      ]
        .join("\n")
        .trimEnd(),
      meta: { ...notification.meta, fallback: "true" },
    };
    enqueuePending(routing, summaryNotification);
  }

  private async postPRComment(
    repo: string,
    prNumber: string,
    profile: HubUserProfile,
    body: string,
  ): Promise<void> {
    // Per-user GitHub token posts as the user; falls back to hub-wide token
    const token = profile.fallback?.github_token ?? process.env.GITHUB_TOKEN;
    if (!token) return;
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) return;

    const truncatedLines = body.split("\n").slice(0, 40);
    const isTruncated = body.split("\n").length > 40;
    const commentBody = [
      `> 🤖 **claude-beacon fallback worker** — @${profile.github_username} had no active sessions`,
      ">",
      ...truncatedLines.map((l) => `> ${l}`),
      isTruncated ? "> _(truncated)_" : "",
    ]
      .join("\n")
      .trimEnd();

    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/comments`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ body: commentBody }),
        },
      );
      if (!res.ok) log(`Failed to post fallback PR comment: ${res.status}`);
    } catch (err) {
      log("Failed to post fallback PR comment:", err);
    }
  }
}

// ── Status line helpers ───────────────────────────────────────────────────────

async function sendStatusLine(server: McpServer, text: string): Promise<void> {
  try {
    await server.server.notification({
      method: "notifications/claude/statusLine",
      params: { text },
    });
  } catch {
    // Best-effort
  }
}

function buildStatusText(
  entry: HubSessionEntry,
  claimKey?: string,
  claimExpiresAt?: number,
): string {
  const reg = entry.branch
    ? `claude-beacon ✓ ${entry.github_username} · ${entry.branch}`
    : `claude-beacon ✓ ${entry.github_username}`;
  if (!claimKey || !claimExpiresAt) return reg;
  const minsLeft = Math.max(1, Math.ceil((claimExpiresAt - Date.now()) / 60_000));
  return `${reg} | claim: ${claimKey} (${minsLeft}m left)`;
}

// ── Session factory ───────────────────────────────────────────────────────────

function createHubSession(profile: HubUserProfile): {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
} {
  const server = createMcpServer();
  let entry: HubSessionEntry | undefined;
  let sessionId = "";

  server.tool(
    "set_filter",
    [
      "Register this Claude Code session's repo and branch so it receives only",
      "matching GitHub CI/PR notifications. Your GitHub identity is already set",
      "from your Bearer token — call once on session startup and again after",
      "switching branches or entering/leaving a worktree.",
    ].join(" "),
    {
      repo: z
        .string()
        .nullable()
        .describe(
          'Full repository name ("owner/repo") parsed from git remote URL, or null for all repos',
        ),
      branch: z
        .string()
        .nullable()
        .describe("Current branch from git, or null for all branches in the repo"),
      label: z
        .string()
        .nullable()
        .optional()
        .describe("Human-readable session name, e.g. 'fix/my-branch'. Shown in conflict messages."),
      worktree_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Absolute path of this session's working directory (git rev-parse --show-toplevel).",
        ),
    },
    async ({ repo, branch, label, worktree_path }) => {
      if (entry) {
        entry.repo = repo;
        entry.branch = branch;
        entry.label = label ? label.replace(/[^\x20-\x7E]/g, "").slice(0, 80) : null;
        entry.worktree_path = worktree_path ?? null;
        saveFilter(profile.github_username, entry.worktree_path, {
          repo,
          branch,
          label: entry.label,
          worktree_path: entry.worktree_path,
        });
      }
      log(
        `Filter set → ${profile.github_username}: ${repo ?? "*"}@${branch ?? "*"} label=${label ?? "-"}`,
      );
      if (entry) {
        const repoAllowed =
          repo === null ||
          config.webhooks.allowed_repos.length === 0 ||
          config.webhooks.allowed_repos.includes(repo);
        if (repoAllowed) await flushPendingToSession(repo, entry);
        await sendStatusLine(server, buildStatusText(entry));
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Filter registered for @${profile.github_username}: ${repo ?? "*"}@${branch ?? "*"}.`,
          },
        ],
      };
    },
  );

  server.tool(
    "get_status",
    [
      "Return a full diagnostic snapshot of this hub session: current filter,",
      "active work claims, pending notification queue (events waiting for a",
      "matching session), and all other registered sessions so you can see what",
      "repos/branches are covered and which events fall outside your filter.",
    ].join(" "),
    {},
    async () => {
      const now = Date.now();

      // ── This session ──────────────────────────────────────────────────────
      const filter = {
        repo: entry?.repo ?? null,
        branch: entry?.branch ?? null,
        label: entry?.label ?? null,
        worktree_path: entry?.worktree_path ?? null,
      };

      const idleMs = entry ? now - entry.lastActivityAt : 0;
      const idleMin = Math.round(idleMs / 60_000);

      // ── Active claims held by this session ────────────────────────────────
      const myClaims = [...workClaims.entries()]
        .filter(([, c]) => c.sessionId === sessionId)
        .map(([key, c]) => ({
          key,
          label: c.label,
          expires_in: `${Math.max(0, Math.ceil((c.expiresAt - now) / 60_000))}m`,
        }));

      // ── Pending queue (events waiting for a session) ──────────────────────
      const pendingQueue = [...pendingByRepo.entries()]
        .map(([repo, items]) => {
          const fresh = items.filter((n) => now - n.receivedAt < config.server.pending_ttl_ms);
          return {
            repo,
            count: fresh.length,
            oldest_age: fresh.length
              ? `${Math.round((now - (fresh[0]?.receivedAt ?? now)) / 60_000)}m`
              : null,
            branches: [...new Set(fresh.map((n) => n.routing.branch ?? "*"))],
          };
        })
        .filter((r) => r.count > 0);

      // ── All active sessions (hub-wide view) ───────────────────────────────
      const allSessions = [...sessions.entries()].map(([id, s]) => ({
        session_id: id.slice(0, 8),
        user: s.github_username,
        repo: s.repo ?? "*",
        branch: s.branch ?? "*",
        label: s.label ?? null,
        idle: `${Math.round((now - s.lastActivityAt) / 60_000)}m`,
        is_me: id === sessionId,
      }));

      // ── Config timeouts ───────────────────────────────────────────────────
      const timeouts = {
        session_idle_ttl: `${Math.round(config.server.session_idle_ttl_ms / 60_000)}m`,
        pending_ttl: `${Math.round(config.server.pending_ttl_ms / 60_000)}m`,
        debounce_ms: config.server.debounce_ms,
        review_debounce_ms: config.server.review_debounce_ms,
      };

      const result = {
        session: {
          id: sessionId.slice(0, 8),
          user: profile.github_username,
          idle: `${idleMin}m`,
          filter,
        },
        active_claims: myClaims,
        pending_queue: pendingQueue,
        all_sessions: allSessions,
        config: timeouts,
      };

      log(`get_status called by ${profile.github_username} (${sessionId.slice(0, 8)})`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "set_behavior",
    [
      "Upload local behavior configuration for this session.",
      "Call once on startup after set_filter, passing the contents of",
      "~/.claude/beacon-behavior.yaml (or any local YAML file).",
      "Overrides hub-config.yaml user.behavior for this session only.",
      "Priority: this call (highest) > hub-config.yaml user.behavior > global defaults.",
    ].join(" "),
    {
      behavior_yaml: z
        .string()
        .describe(
          "YAML string — same schema as hub-config.yaml user.behavior. " +
            "Keys: code_style, on_pr_review, on_ci_failure_main, on_ci_failure_branch, " +
            "on_merge_conflict, on_branch_behind, on_pr_opened, on_pr_approved.",
        ),
    },
    async ({ behavior_yaml }) => {
      let parsed: unknown;
      try {
        parsed = parse(behavior_yaml);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Invalid YAML: ${err}` }] };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          content: [{ type: "text" as const, text: "behavior_yaml must be a YAML mapping object" }],
        };
      }
      if (entry) {
        entry.behavior = parsed as Partial<HubUserBehavior>;
      }
      log(`Behavior set for @${profile.github_username} (session ${sessionId.slice(0, 8)})`);
      return {
        content: [
          {
            type: "text" as const,
            text: "Behavior config applied for this session. Instructions will use your local overrides.",
          },
        ],
      };
    },
  );

  server.tool(
    "claim_notification",
    [
      "Claim exclusive ownership of work for a repo+branch before acting on a notification.",
      "Returns: 'ok' (claimed), 'already_owned' (TTL extended), 'conflict:<who>' (stop), 'expired' (stop).",
    ].join(" "),
    {
      claim_key: z
        .string()
        .describe(
          "'{repo}:{branch}' from notification meta.claim_key, or construct from git remote + current branch",
        ),
    },
    async ({ claim_key }) => {
      const existing = workClaims.get(claim_key);
      const ttl = config.server.claim_ttl_ms;
      const myLabel = entry?.label ?? sessionId.slice(0, 8);

      if (existing && Date.now() <= existing.expiresAt) {
        if (existing.sessionId === sessionId) {
          existing.expiresAt = Date.now() + ttl;
          if (entry)
            await sendStatusLine(server, buildStatusText(entry, claim_key, existing.expiresAt));
          return { content: [{ type: "text" as const, text: "already_owned" }] };
        }
        const winner = existing.label ?? existing.sessionId.slice(0, 8);
        return { content: [{ type: "text" as const, text: `conflict:${winner}` }] };
      }

      const expiresAt = Date.now() + ttl;
      workClaims.set(claim_key, { sessionId, label: myLabel, expiresAt });
      writeClaimFile(claim_key);
      log(`Claim granted: ${myLabel} owns ${claim_key}`);
      if (entry) await sendStatusLine(server, buildStatusText(entry, claim_key, expiresAt));
      // Cancel fallback — session is handling the work
      fallbackWorker.cancel(claim_key);
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  server.tool(
    "release_claim",
    "Release the branch claim when work is complete. Frees the branch immediately.",
    {
      claim_key: z.string().describe("The same claim_key passed to claim_notification"),
    },
    async ({ claim_key }) => {
      const existing = workClaims.get(claim_key);
      if (!existing || existing.sessionId !== sessionId) {
        return { content: [{ type: "text" as const, text: "not_owner" }] };
      }
      workClaims.delete(claim_key);
      deleteClaimFile();
      log(`Claim released: ${entry?.label ?? sessionId.slice(0, 8)} released ${claim_key}`);
      if (entry) await sendStatusLine(server, buildStatusText(entry));
      return { content: [{ type: "text" as const, text: "released" }] };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const id = randomUUID();
      sessionId = id;
      return id;
    },
    eventStore: new NotificationEventStore(),
    onsessioninitialized: (id) => {
      sessionId = id;
      const df = profile.default_filter;
      // Only restore if user has exactly one DB row — avoids wrong-filter restoration for
      // multi-session users whose last set_filter call may have come from a different session.
      const pf = loadUniqueFilter(profile.github_username);

      // Priority: persisted filter (from last set_filter call) > default_filter from config > null
      const effectiveRepo = pf?.repo ?? df?.repo ?? null;
      const effectiveBranch = pf?.branch ?? df?.branch ?? null;
      const rawLabel = pf?.label ?? df?.label ?? null;
      const effectiveLabel = rawLabel ? rawLabel.replace(/[^\x20-\x7E]/g, "").slice(0, 80) : null;
      const effectivePath = pf?.worktree_path ?? null;

      entry = {
        server,
        transport,
        github_username: profile.github_username,
        repo: effectiveRepo,
        branch: effectiveBranch,
        label: effectiveLabel,
        worktree_path: effectivePath,
        lastActivityAt: Date.now(),
      };
      sessions.set(id, entry);
      addUserSession(profile.github_username, id);

      const source = pf ? "persisted (unique)" : df ? "default_filter" : "none";
      log(
        `Session connected: ${id.slice(0, 8)} (${profile.github_username}) (total: ${sessions.size})`,
      );

      if (pf !== null || df !== undefined) {
        log(`Auto-filter applied: ${effectiveRepo ?? "*"}@${effectiveBranch ?? "*"} [${source}]`);
        const capturedEntry = entry;
        const repoAllowed =
          effectiveRepo === null ||
          config.webhooks.allowed_repos.length === 0 ||
          config.webhooks.allowed_repos.includes(effectiveRepo);
        if (repoAllowed) {
          flushPendingToSession(effectiveRepo, capturedEntry)
            .then(() => sendStatusLine(server, buildStatusText(capturedEntry)))
            .catch((err) => log("Auto-filter flush failed:", err));
        } else {
          sendStatusLine(server, buildStatusText(capturedEntry)).catch(() => {});
        }
      }
    },
    onsessionclosed: (id) => {
      const session = sessions.get(id);
      if (session) removeUserSession(session.github_username, id);
      sessions.delete(id);
      for (const [k, c] of workClaims) {
        if (c.sessionId === id) {
          workClaims.delete(k);
          log(`Claim cleared on disconnect: ${k}`);
        }
      }
      log(
        `Session disconnected: ${id.slice(0, 8)} (${profile.github_username}) (total: ${sessions.size})`,
      );
    },
  });

  return { server, transport };
}

// ── Notification routing ──────────────────────────────────────────────────────

const routeToSessions: NotifyFn = async (
  notification: CINotification,
  routing: RoutingKey,
): Promise<void> => {
  const claimKey = claimKeyFor(routing);
  const existing = workClaims.get(claimKey);

  // Pre-routing: active claim → send only to the owner
  if (existing && Date.now() <= existing.expiresAt) {
    const ownerSession = sessions.get(existing.sessionId);
    if (ownerSession) {
      const enriched = enrichNotification(notification, claimKey, "owned");
      try {
        await sendChannelNotification(ownerSession.server, enriched);
        ownerSession.lastActivityAt = Date.now();
        log(
          `Routed to claim owner ${existing.label ?? existing.sessionId.slice(0, 8)}: ${claimKey}`,
        );
      } catch (err) {
        log("Failed to push to claim owner — clearing stale claim, re-broadcasting:", err);
        workClaims.delete(claimKey);
      }
      return;
    }
    log(`Claim owner for ${claimKey} is gone — clearing claim, re-broadcasting`);
    workClaims.delete(claimKey);
  }

  const { recipients, mode } = selectHubRecipients(routing, sessions, userSessions);

  if (recipients.length === 0) {
    log(`No session found for ${routing.repo}@${routing.branch ?? "*"} — queuing for replay.`);
    enqueuePending(routing, notification);
    maybeStartFallback(claimKey, notification, routing);
    return;
  }

  if (mode === "catchall") {
    log(
      `⚠️  No session on ${routing.branch ?? "*"} — using catch-all (${recipients.length} sessions)`,
    );
  }

  const enriched = enrichNotification(notification, claimKey, mode);
  let sent = 0;
  for (const session of recipients) {
    // When the notification has a reviewer_summary (PR review events only), send the
    // reviewer variant to sessions whose user is not the PR author. This lets the hub
    // distinguish "address comments on your PR" from "help me review someone else's PR".
    const isAuthor = routing.pr_author != null && session.github_username === routing.pr_author;
    const toSend =
      !isAuthor && enriched.reviewer_summary != null
        ? { ...enriched, summary: enriched.reviewer_summary }
        : enriched;
    try {
      await sendChannelNotification(session.server, toSend);
      session.lastActivityAt = Date.now();
      sent++;
    } catch (err) {
      log("Failed to push notification to session:", err);
    }
  }
  if (sent > 0) {
    const names = [...new Set(recipients.map((s) => s.github_username))].join(", ");
    log(
      `Accepted by ${sent} session(s) (${names}): ${routing.repo}@${routing.branch ?? "*"} — see [sse] lines for delivery status`,
    );
    // Start fallback timer even after delivery — fires if no session claims within timeout
    maybeStartFallback(claimKey, notification, routing);
  }
};

function maybeStartFallback(
  claimKey: string,
  notification: CINotification,
  routing: RoutingKey,
): void {
  const authorUsername = routing.pr_author ?? null;
  if (!authorUsername) return;
  const profile = [...tokenMap.values()].find((u) => u.github_username === authorUsername);
  if (!profile) return;
  const eventType = notification.meta.event_type ?? "on_pr_review";
  fallbackWorker.watch(claimKey, notification, routing, profile, eventType);
}

// ── MCP HTTP server ───────────────────────────────────────────────────────────

const MCP_PORT = Number(process.env.MCP_PORT ?? 9444);

// Inject SSE comment pings every 25 s so reverse proxies don't close idle streams.
// Proxies (nginx default: 60 s) interpret silence as a dead connection.
const SSE_PING_INTERVAL_MS = 25_000;

function withSsePing(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }
  const encoder = new TextEncoder();
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      pingTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(pingTimer);
          pingTimer = undefined;
        }
      }, SSE_PING_INTERVAL_MS);
    },
    flush() {
      clearInterval(pingTimer);
      pingTimer = undefined;
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function startMcpServer(): void {
  Bun.serve({
    port: MCP_PORT,
    // NOT restricted to 127.0.0.1 — hub is exposed via a reverse proxy that handles TLS.
    // The proxy should enforce HTTPS; this server trusts the proxy.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(
          JSON.stringify({ status: "ok", server: "claude-beacon-hub", sessions: sessions.size }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      if (req.method === "POST" && url.pathname === "/release-claim") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        const claimKey =
          typeof (body as Record<string, unknown>)?.claim_key === "string"
            ? (body as Record<string, string>).claim_key
            : null;
        if (!claimKey || !workClaims.has(claimKey)) {
          return new Response("not_found", { status: 404 });
        }
        workClaims.delete(claimKey);
        deleteClaimFile();
        fallbackWorker.cancel(claimKey);
        log(`Claim released via HTTP: ${claimKey}`);
        return new Response("released", { status: 200 });
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      // ── Bearer auth ────────────────────────────────────────────────────────
      const profile = bearerAuth(req, tokenMap);
      if (!profile) {
        return new Response("Unauthorized — valid Bearer token required", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="claude-beacon-hub"' },
        });
      }

      const sessionId = req.headers.get("mcp-session-id");

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return new Response("Session not found", { status: 404 });
        // Security: token must match the session's registered user
        if (session.github_username !== profile.github_username) {
          return new Response("Forbidden", { status: 403 });
        }
        session.lastActivityAt = Date.now();
        return withSsePing(await session.transport.handleRequest(req));
      }

      if (req.method !== "POST") {
        return new Response("Bad Request — send POST to initialize a new session", { status: 400 });
      }

      const { server, transport } = createHubSession(profile);
      await server.connect(transport);
      return withSsePing(await transport.handleRequest(req));
    },
  });
  log(`MCP HTTP server listening on http://0.0.0.0:${MCP_PORT}/mcp`);
  log("Reverse proxy required for HTTPS. nginx: add 'proxy_read_timeout 0' for SSE.");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cliArgs = process.argv.slice(2);

  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(`claude-beacon-hub — Hub server for GitHub CI/PR notifications

Usage (solo developer):
  claude-beacon-hub --author <GitHubUsername>

Usage (team / advanced):
  claude-beacon-hub --config <path/to/hub-config.yaml>

Options:
  --author <login>  Single-user mode. Derives a stable Bearer token from
                    GITHUB_WEBHOOK_SECRET. Token is printed on startup.
  --config <path>   YAML config with 'hub:' section (multiple users, fallback
                    worker, per-user behavior). See config.example.yaml.
  --help, -h        Show this message.

Environment variables (put in .env next to config or in CWD):
  GITHUB_WEBHOOK_SECRET   HMAC-SHA256 secret matching your GitHub App webhook (required)
  GITHUB_TOKEN            PAT with Actions:Read + Pull requests:Read
  ANTHROPIC_API_KEY       Required when fallback.enabled: true
  WEBHOOK_PORT            Webhook receiver port (default: 9443)
  MCP_PORT                MCP HTTP port (default: 9444)

Full docs: https://github.com/drmf-cz/claude-beacon/blob/main/docs/hub-mode.md\n`);
    process.exit(0);
  }

  const configIdx = cliArgs.indexOf("--config");
  const configPath = configIdx !== -1 ? (cliArgs[configIdx + 1] ?? null) : null;

  const authorIdx = cliArgs.indexOf("--author");
  const authorArg = authorIdx !== -1 ? (cliArgs[authorIdx + 1] ?? null) : null;

  if (!configPath && !authorArg) {
    process.stderr.write(
      "ERROR: either --author <GitHubUsername> or --config <path> is required.\n" +
        "Run with --help for usage.\n",
    );
    process.exit(1);
  }

  if (configPath && authorArg) {
    process.stderr.write("ERROR: --author and --config are mutually exclusive.\n");
    process.exit(1);
  }

  if (configPath) {
    // ── YAML config mode (team / advanced) ──────────────────────────────────
    // Load .env from next to the config file before reading any env vars.
    loadDotEnv(configPath);

    try {
      const loaded = loadHubConfig(configPath);
      config = loaded.config;
      hubConfig = loaded.hub;
      log(`Loaded hub config from ${configPath}: ${hubConfig.users.length} user(s)`);
    } catch (err) {
      process.stderr.write(`ERROR: Failed to load config: ${err}\n`);
      process.exit(1);
    }

    tokenMap = new Map(hubConfig.users.map((u) => [u.token, u]));
    config.webhooks.allowed_authors = hubConfig.users.map((u) => u.github_username);
    log(`Hub users: ${hubConfig.users.map((u) => u.github_username).join(", ")}`);
    const dbPath =
      hubConfig.session_store_path ?? join(dirname(resolve(configPath)), "hub-session-filters.db");
    openFilterStore(dbPath);
    log(`Session filter store: ${dbPath}`);
    log(
      `Timeouts: idle=${config.server.session_idle_ttl_ms / 60_000}m pending=${config.server.pending_ttl_ms / 60_000}m debounce=${config.server.debounce_ms}ms review_debounce=${config.server.review_debounce_ms}ms`,
    );
  } else {
    // ── Single-user --author mode ────────────────────────────────────────────
    // Load .env from CWD (no config file path to derive from).
    loadDotEnv(join(process.cwd(), ".env"));

    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!webhookSecret) {
      process.stderr.write(
        "ERROR: GITHUB_WEBHOOK_SECRET is not set.\n" +
          `  Put it in ${process.cwd()}/.env or export it before starting.\n`,
      );
      process.exit(1);
    }

    // Derive a stable Bearer token from the webhook secret + username.
    // Token changes only when the webhook secret is rotated.
    const bearerToken = createHmac("sha256", webhookSecret)
      .update(`hub-token:${authorArg}`)
      .digest("hex");

    const profile: HubUserProfile = { github_username: authorArg as string, token: bearerToken };
    hubConfig = {
      users: [profile],
      fallback: {
        enabled: false,
        timeout_ms: 900_000,
        model: "claude-sonnet-4-6",
        notify_via_pr_comment: true,
      },
    };
    config = { ...DEFAULT_CONFIG };
    config.webhooks.allowed_authors = [authorArg as string];
    tokenMap = new Map([[bearerToken, profile]]);
    openFilterStore(join(process.cwd(), "hub-session-filters.db"));
    log(`Session filter store: ${process.cwd()}/hub-session-filters.db`);
    log(
      `Single-user mode: no config file — all timeouts use defaults (idle=30m, pending=120m). Use --config to customise.`,
    );

    const mcpPort = Number(process.env.MCP_PORT ?? 9444);
    process.stderr.write(
      "\n──────────────────────────────────────────────────────────────\n" +
        `Hub running in single-user mode for @${authorArg}\n\n` +
        "Run this once to connect Claude Code:\n\n" +
        `  claude mcp remove claude-beacon 2>/dev/null; \\\n` +
        `  claude mcp add --transport http claude-beacon http://127.0.0.1:${mcpPort}/mcp \\\n` +
        `    --header "Authorization: Bearer ${bearerToken}"\n\n` +
        "To scale to a team, switch to --config. See docs/hub-mode.md\n" +
        "──────────────────────────────────────────────────────────────\n\n",
    );
  }

  // ── Shared startup (both modes) ───────────────────────────────────────────
  {
    log(`Working directory: ${process.cwd()} (Bun also auto-loads .env from here)`);
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!webhookSecret) {
      process.stderr.write(
        "ERROR: GITHUB_WEBHOOK_SECRET is not set.\n" +
          "  Put it in .env or export it before starting.\n",
      );
      process.exit(1);
    }
    log(`GITHUB_WEBHOOK_SECRET found (${webhookSecret.length} chars)`);

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      log("WARNING: GITHUB_TOKEN is not set. Log fetching and fallback PR comments will not work.");
    } else {
      log(`GITHUB_TOKEN found: ${token.slice(0, 8)}...`);
    }
  }

  // Initialise fallback worker (depends on hubConfig)
  fallbackWorker = new FallbackWorker(hubConfig);

  startMcpServer();

  // Build a per-user config resolver: maps pr_author → their merged Config.
  // Priority: session behavior (set_behavior tool) > user behavior (hub-config.yaml) > global.
  const configResolver = (routing: RoutingKey): Config => {
    const prAuthor = routing.pr_author;
    if (!prAuthor) return config;
    const profile = [...tokenMap.values()].find((u) => u.github_username === prAuthor);
    if (!profile) return config;

    // Pick session behavior from the most recently active session for this user.
    const userSessionIds = userSessions.get(prAuthor) ?? new Set<string>();
    let sessionBehavior: Partial<HubUserBehavior> | undefined;
    let latestActivity = 0;
    for (const sid of userSessionIds) {
      const s = sessions.get(sid);
      if (s?.behavior && s.lastActivityAt > latestActivity) {
        sessionBehavior = s.behavior;
        latestActivity = s.lastActivityAt;
      }
    }

    return resolveUserConfig(config, profile, sessionBehavior);
  };

  try {
    const webhookServer = startWebhookServer(routeToSessions, config, configResolver);
    log(`Webhook server listening on http://localhost:${webhookServer.port}`);
  } catch (err: unknown) {
    const isAddrInUse =
      typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
    process.stderr.write(
      isAddrInUse
        ? `ERROR: Port ${config.server.port} is already in use.\n`
        : `ERROR: Failed to start webhook server: ${err}\n`,
    );
    process.exit(1);
  }

  log("Hub ready — waiting for Claude Code sessions and GitHub webhook events.");
} // end import.meta.main
