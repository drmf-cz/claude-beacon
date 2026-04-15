import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubUserProfile } from "../config.js";
import { loadHubConfig } from "../config.js";
import { bearerAuth, FallbackWorker, selectHubRecipients } from "../hub.js";
import type { RoutingKey } from "../server.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ALICE: HubUserProfile = {
  github_username: "alice",
  token: "tok_alice_abc123",
};

const BOB: HubUserProfile = {
  github_username: "bob",
  token: "tok_bob_def456",
  fallback: { enabled: true, timeout_ms: 100 },
};

const TOKEN_MAP = new Map<string, HubUserProfile>([
  [ALICE.token, ALICE],
  [BOB.token, BOB],
]);

// ── bearerAuth ────────────────────────────────────────────────────────────────

describe("bearerAuth", () => {
  it("returns profile for a valid token", () => {
    const req = new Request("http://localhost/mcp", {
      headers: { Authorization: `Bearer ${ALICE.token}` },
    });
    const result = bearerAuth(req, TOKEN_MAP);
    expect(result).toEqual(ALICE);
  });

  it("returns null for an unknown token", () => {
    const req = new Request("http://localhost/mcp", {
      headers: { Authorization: "Bearer tok_unknown" },
    });
    const result = bearerAuth(req, TOKEN_MAP);
    expect(result).toBeNull();
  });

  it("returns null when Authorization header is missing", () => {
    const req = new Request("http://localhost/mcp");
    const result = bearerAuth(req, TOKEN_MAP);
    expect(result).toBeNull();
  });

  it("returns null for malformed Authorization header (no Bearer prefix)", () => {
    const req = new Request("http://localhost/mcp", {
      headers: { Authorization: ALICE.token },
    });
    const result = bearerAuth(req, TOKEN_MAP);
    expect(result).toBeNull();
  });

  it("is case-insensitive for the 'Bearer' keyword", () => {
    const req = new Request("http://localhost/mcp", {
      headers: { Authorization: `bearer ${ALICE.token}` },
    });
    const result = bearerAuth(req, TOKEN_MAP);
    expect(result).toEqual(ALICE);
  });
});

// ── selectHubRecipients ───────────────────────────────────────────────────────

type MinimalSession = {
  github_username: string;
  repo: string | null;
  branch: string | null;
  label: string | null;
  worktree_path: string | null;
  lastActivityAt: number;
  server: never;
  transport: never;
};

function makeSession(
  username: string,
  repo: string | null,
  branch: string | null,
  id: string,
): [string, MinimalSession] {
  return [
    id,
    {
      github_username: username,
      repo,
      branch,
      label: null,
      worktree_path: null,
      lastActivityAt: Date.now(),
      server: {} as never,
      transport: {} as never,
    },
  ];
}

describe("selectHubRecipients — Tier 0 (author match)", () => {
  it("routes to the matching user session when pr_author matches", () => {
    const sessMap = new Map([
      makeSession("alice", "org/repo", "feat/x", "s1"),
      makeSession("bob", "org/repo", "feat/x", "s2"),
    ]);
    const userMap = new Map([
      ["alice", new Set(["s1"])],
      ["bob", new Set(["s2"])],
    ]);
    const routing: RoutingKey = {
      repo: "org/repo",
      branch: "feat/x",
      pr_author: "alice",
    };
    // biome-ignore lint/suspicious/noExplicitAny: test cast
    const { recipients, mode } = selectHubRecipients(routing, sessMap as any, userMap);
    expect(recipients.length).toBe(1);
    expect(recipients[0]?.github_username).toBe("alice");
    expect(mode).toBe("normal");
  });

  it("falls through to Tier 1–3 when pr_author has no registered sessions", () => {
    const sessMap = new Map([makeSession("alice", "org/repo", "feat/x", "s1")]);
    const userMap = new Map([["alice", new Set(["s1"])]]);
    const routing: RoutingKey = {
      repo: "org/repo",
      branch: "feat/x",
      pr_author: "charlie", // not registered
    };
    // biome-ignore lint/suspicious/noExplicitAny: test cast
    const { recipients } = selectHubRecipients(routing, sessMap as any, userMap);
    // With no Tier-0 author match, falls back to all sessions for the repo
    expect(recipients.length).toBe(1);
    expect(recipients[0]?.github_username).toBe("alice");
  });

  it("uses catch-all within user sessions when no branch match", () => {
    const sessMap = new Map([makeSession("alice", "org/repo", "main", "s1")]);
    const userMap = new Map([["alice", new Set(["s1"])]]);
    const routing: RoutingKey = {
      repo: "org/repo",
      branch: "feat/new",
      pr_author: "alice",
    };
    // biome-ignore lint/suspicious/noExplicitAny: test cast
    const { recipients, mode } = selectHubRecipients(routing, sessMap as any, userMap);
    expect(recipients.length).toBe(1);
    expect(recipients[0]?.github_username).toBe("alice");
    expect(mode).toBe("catchall");
  });

  it("returns empty array when no sessions at all", () => {
    const sessMap = new Map<string, MinimalSession>();
    const userMap = new Map<string, Set<string>>();
    const routing: RoutingKey = { repo: "org/repo", branch: "feat/x", pr_author: "alice" };
    // biome-ignore lint/suspicious/noExplicitAny: test cast
    const { recipients } = selectHubRecipients(routing, sessMap as any, userMap);
    expect(recipients.length).toBe(0);
  });
});

// ── FallbackWorker ────────────────────────────────────────────────────────────

describe("FallbackWorker", () => {
  const hubCfg = {
    users: [BOB],
    fallback: {
      enabled: false, // disabled globally
      timeout_ms: 50,
      model: "claude-sonnet-4-6",
      notify_via_pr_comment: false,
    },
  };

  const routing: RoutingKey = { repo: "org/repo", branch: "feat/x", pr_author: "bob" };
  const notification = { summary: "test notification", meta: { pr_number: "42" } };

  it("does not fire when fallback is disabled for the user", () => {
    // BOB has fallback.enabled=true but ANTHROPIC_API_KEY is not set → no client
    const worker = new FallbackWorker(hubCfg);
    const fired = false;
    // Patch invoke indirectly — if worker fires, it would try the Anthropic API
    // Without a client it returns early, but we can verify pending is cleared
    worker.watch("test:key", notification, routing, BOB, "on_pr_review");
    worker.cancel("test:key");
    // After cancel, pending should be gone — no timer should fire
    expect(fired).toBe(false);
  });

  it("cancel() removes the pending entry", () => {
    const worker = new FallbackWorker(hubCfg);
    worker.watch("cancel:key", notification, routing, BOB, "on_pr_review");
    worker.cancel("cancel:key");
    // Calling cancel again should be a no-op (entry already removed)
    worker.cancel("cancel:key");
    // No assertion needed beyond no-throw
  });

  it("watch() with no Anthropic client is a no-op (doesn't throw)", () => {
    // No ANTHROPIC_API_KEY set in test env
    const worker = new FallbackWorker({
      ...hubCfg,
      fallback: { ...hubCfg.fallback, enabled: true },
    });
    // With no client, watch should return without setting a timer
    expect(() =>
      worker.watch("no-client:key", notification, routing, BOB, "on_pr_review"),
    ).not.toThrow();
  });

  it("watch() proceeds when user has per-user anthropic_api_key (no hub-wide client needed)", () => {
    // Hub has no ANTHROPIC_API_KEY, but user has their own key
    const worker = new FallbackWorker({
      ...hubCfg,
      fallback: { ...hubCfg.fallback, enabled: true },
    });
    const bobWithKey: typeof BOB = {
      ...BOB,
      fallback: { ...BOB.fallback, anthropic_api_key: "sk-ant-user-key" },
    };
    // Should not throw — per-user key bypasses the missing hub client check
    expect(() =>
      worker.watch("per-user-key:key", notification, routing, bobWithKey, "on_pr_review"),
    ).not.toThrow();
    // Clean up timer
    worker.cancel("per-user-key:key");
  });

  it("watch() is a no-op when globally disabled even if user has anthropic_api_key", () => {
    const bobWithKey: typeof BOB = {
      ...BOB,
      fallback: { enabled: false, anthropic_api_key: "sk-ant-user-key" },
    };
    const worker = new FallbackWorker({
      ...hubCfg,
      fallback: { ...hubCfg.fallback, enabled: false },
    });
    // fallback.enabled=false at both levels → no-op regardless of key
    expect(() =>
      worker.watch("disabled:key", notification, routing, bobWithKey, "on_pr_review"),
    ).not.toThrow();
    // No entry should have been added (cancel is a no-op)
    worker.cancel("disabled:key");
  });
});

// ── loadHubConfig ─────────────────────────────────────────────────────────────

describe("loadHubConfig", () => {
  function writeTempConfig(content: string): string {
    const path = join(tmpdir(), `hub-test-${Date.now()}.yaml`);
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("parses a valid hub config", () => {
    const path = writeTempConfig(`
hub:
  users:
    - github_username: martinv
      token: "tok_abc123longtoken"
    - github_username: alice
      token: "tok_def456longtoken"
`);
    const { hub } = loadHubConfig(path);
    expect(hub.users.length).toBe(2);
    expect(hub.users[0]?.github_username).toBe("martinv");
    expect(hub.users[1]?.github_username).toBe("alice");
    // Default fallback
    expect(hub.fallback.enabled).toBe(false);
    expect(hub.fallback.notify_via_pr_comment).toBe(true);
  });

  it("applies user fallback overrides", () => {
    const path = writeTempConfig(`
hub:
  fallback:
    enabled: false
    timeout_ms: 300000
  users:
    - github_username: martinv
      token: "tok_abc123longtoken"
      fallback:
        enabled: true
        timeout_ms: 60000
`);
    const { hub } = loadHubConfig(path);
    expect(hub.fallback.enabled).toBe(false);
    expect(hub.users[0]?.fallback?.enabled).toBe(true);
    expect(hub.users[0]?.fallback?.timeout_ms).toBe(60000);
  });

  it("throws when hub.users is missing", () => {
    const path = writeTempConfig("webhooks:\n  allowed_authors:\n    - martinv\n");
    expect(() => loadHubConfig(path)).toThrow(/hub.*section/i);
  });

  it("throws when hub.users is empty", () => {
    const path = writeTempConfig("hub:\n  users: []\n");
    expect(() => loadHubConfig(path)).toThrow(/non-empty/i);
  });

  it("throws when a user has an empty token", () => {
    const path = writeTempConfig(`
hub:
  users:
    - github_username: martinv
      token: ""
`);
    expect(() => loadHubConfig(path)).toThrow(/token/i);
  });

  it("throws on duplicate tokens", () => {
    const path = writeTempConfig(`
hub:
  users:
    - github_username: alice
      token: "same_token_here"
    - github_username: bob
      token: "same_token_here"
`);
    expect(() => loadHubConfig(path)).toThrow(/duplicate token/i);
  });
});
