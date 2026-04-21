import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

// ── Config Types ──────────────────────────────────────────────────────────────

export interface ServerConfig {
  /** HTTP port for the webhook server. Env override: WEBHOOK_PORT */
  port: number;
  /** Milliseconds to wait before firing a batched review notification. Env override: REVIEW_DEBOUNCE_MS */
  debounce_ms: number;
  /** Milliseconds to suppress further notifications for the same PR after one fires. */
  cooldown_ms: number;
  /** Maximum review events buffered per debounce window (memory / prompt-size guard). */
  max_events_per_window: number;
  /** Branch names treated as the default/main branch for CI failure escalation. */
  main_branches: string[];
  /**
   * How long a work-context claim holds before expiring (milliseconds).
   * Claims are auto-renewed when the owner calls claim_notification again.
   * Default: 10 minutes.
   */
  claim_ttl_ms: number;
  /**
   * How long a hub session can be idle before it is evicted from memory (milliseconds).
   * Idle = no MCP requests received from the Claude Code client.
   * Increase this if your Claude Code sessions disconnect and reconnect frequently
   * and you want the hub to retain their registrations longer.
   * Default: 30 minutes.
   */
  session_idle_ttl_ms: number;
  /**
   * How long a queued notification is retained waiting for a matching session (milliseconds).
   * Notifications are queued when no session is registered for the target repo/branch.
   * They are delivered as soon as a session calls set_filter with a matching repo.
   * Increase this if you start Claude Code sessions infrequently and want to receive
   * notifications that arrived while no session was running.
   * Default: 2 hours.
   */
  pending_ttl_ms: number;
}

export interface WebhooksConfig {
  /**
   * REQUIRED — GitHub usernames and/or email addresses whose PRs trigger actions.
   * MCP refuses to start if this list is empty.
   *
   * Two kinds of entries:
   * - Plain username (no "@"): matched against pr.user.login (the PR author's GitHub handle).
   * - Email address (contains "@"): matched against Co-Authored-By commit headers.
   *   Use this when a bot like Devin creates the PR on your behalf — your email appears
   *   in the commit's Co-Authored-By trailer even though the PR author is the bot.
   *
   * Example: ["Matovidlo", "martin@company.com"]
   */
  allowed_authors: string[];
  /**
   * GitHub event types to process. Empty array means all supported events are processed.
   *
   * Supported values: push, workflow_run, workflow_job, check_suite, check_run,
   * pull_request, pull_request_review, pull_request_review_comment,
   * pull_request_review_thread, issue_comment
   */
  allowed_events: string[];
  /**
   * Repository full names (owner/repo) to process. Empty array means all repositories.
   * Example: ["myorg/frontend", "myorg/backend"]
   */
  allowed_repos: string[];
  /**
   * When true (default), review events sent by someone in allowed_authors are silently
   * dropped. This prevents an infinite loop: Claude replies to a review → that reply fires
   * a new webhook → Claude replies again → ...
   *
   * Set to false if you want Claude to react to your own PR comments — for example, when
   * you leave a comment on your own PR to instruct Claude what to fix next. You are then
   * responsible for not triggering a loop (e.g. by having Claude reply in a way that does
   * not itself post a new review comment).
   */
  skip_own_comments: boolean;
}

export interface CIFailureBehavior {
  /**
   * Instruction template appended to CI failure notifications.
   *
   * Available placeholders: {repo}, {branch}, {run_url}, {workflow}, {status}, {commit}
   *
   * The special placeholder {health_check_step} is replaced automatically based on
   * the `upstream_sync` field below — include it in the template wherever you want
   * the sync step to appear, or omit it entirely to suppress the step.
   *
   * The special placeholder {use_agent_preamble} is replaced with either a directive
   * to spawn a subagent (when use_agent=true) or to act in the current session
   * (when use_agent=false). Include it wherever you want that line to appear.
   */
  instruction: string;
  /**
   * When true (default), a "step 0" is injected via the {health_check_step} placeholder:
   * fetch + rebase origin/main before diagnosing the failure. This catches cases where
   * the branch is simply stale and the failure is already fixed upstream.
   *
   * Set to false to skip the sync step (e.g. on repos where main is frequently broken,
   * or when you handle rebasing separately).
   */
  upstream_sync: boolean;
  /**
   * When true (default), Claude spawns a subagent via the Agent tool to investigate
   * and fix the CI failure. This keeps the parent session free for other work.
   *
   * Set to false to have Claude act inline in the current session — useful for solo
   * developers who prefer a single context or who find the subagent latency disruptive.
   */
  use_agent: boolean;
}

/**
 * Controls how git worktrees are created for subagent tasks.
 *
 * - "temp": classic shell worktree — `git worktree add /tmp/... && git worktree remove`
 * - "native": Claude Code's Agent tool with `isolation: "worktree"` — Claude manages the
 *   worktree lifecycle automatically; no manual add/remove needed.
 */
export type WorktreeMode = "temp" | "native";

export interface WorktreeConfig {
  /**
   * Worktree strategy used when spawning subagents for rebase / conflict resolution.
   * Defaults to "temp". Use "native" if you work in Claude Code worktrees natively
   * (i.e. you run `claude` from inside an Agent-managed worktree).
   */
  mode: WorktreeMode;
  /**
   * Base directory for temporary worktrees created in "temp" mode.
   * The actual path is {base_dir}/{repo_slug}-pr-{N}-rebase.
   * Including the repo slug prevents collisions when multiple repos share the same mux.
   * Default: "/tmp"
   */
  base_dir: string;
}

export interface PRReviewBehavior {
  /** Skill name invoked during the execution phase. */
  skill: string;
  /**
   * When true, the PR review work runs as a subagent inside an isolated Claude Code
   * worktree (Agent tool with isolation="worktree") instead of the current session.
   * Useful when you normally work inside native worktrees.
   */
  use_worktree: boolean;
  /**
   * Instruction text appended to PR review notifications.
   *
   * Available placeholders:
   *   {skill}             — replaced with the skill field above
   *   {worktree_preamble} — empty when use_worktree=false; when true, a sentence
   *                         telling the subagent it already runs in an isolated worktree
   */
  instruction: string;
}

export interface PRStateBehavior {
  /**
   * Instruction template for PRs in a conflict or behind state.
   *
   * Available placeholders: {repo}, {pr_number}, {pr_title}, {pr_url}, {head_branch},
   *   {base_branch}, {worktree_steps} — mode-appropriate rebase/cleanup commands
   */
  instruction: string;
}

export type DependabotMinSeverity = "low" | "medium" | "high" | "critical";
export type CodeScanningMinSeverity = "note" | "warning" | "error";

export interface SecurityAlertBehavior<S extends string> {
  /**
   * Whether this alert handler is active. Defaults to false.
   *
   * Security alerts broadcast to ALL sessions registered for the repo. In shared/team
   * environments, multiple Claude Code instances would all receive the alert. Set to true
   * only on the single instance responsible for security triage.
   */
  enabled: boolean;
  /**
   * Minimum severity required to trigger a notification.
   * Alerts below this threshold are silently skipped.
   */
  min_severity: S;
  /**
   * Instruction template appended to security alert notifications.
   *
   * Dependabot placeholders: {repo}, {cve}, {package}, {severity}, {alert_url}, {patched_version}
   * Code scanning placeholders: {repo}, {rule}, {severity}, {alert_url}, {branch}, {tool}
   */
  instruction: string;
}

export interface PROpenedBehavior {
  /**
   * Whether to notify when a PR is opened, reopened, or marked ready for review.
   * Disabled by default — enable on the session responsible for automated first-pass review.
   */
  enabled: boolean;
  /**
   * Instruction template appended to PR-opened notifications.
   *
   * Available placeholders: {repo}, {pr_number}, {pr_title}, {pr_url},
   *   {head_branch}, {base_branch}, {author}
   */
  instruction: string;
}

export interface PRApprovedBehavior {
  /**
   * Whether to use a separate handler for APPROVED reviews instead of on_pr_review.
   * Disabled by default. When enabled, APPROVED reviews no longer flow to on_pr_review.
   */
  enabled: boolean;
  /**
   * Instruction template appended to PR-approved notifications.
   *
   * Available placeholders: {repo}, {pr_number}, {pr_title}, {pr_url}, {reviewer}
   */
  instruction: string;
}

export interface BehaviorConfig {
  /** Worktree strategy for all subagent operations. */
  worktrees: WorktreeConfig;
  /** Behaviour when a CI run fails on a main/master branch. */
  on_ci_failure_main: CIFailureBehavior;
  /** Behaviour when a CI run fails on a feature branch. */
  on_ci_failure_branch: CIFailureBehavior;
  /** Behaviour when a PR review or comment arrives. */
  on_pr_review: PRReviewBehavior;
  /** Behaviour when a PR has merge conflicts (mergeable_state=dirty). */
  on_merge_conflict: PRStateBehavior;
  /** Behaviour when a PR is behind its base branch (mergeable_state=behind). */
  on_branch_behind: PRStateBehavior;
  /** Behaviour when a Dependabot security alert is created or reintroduced. */
  on_dependabot_alert: SecurityAlertBehavior<DependabotMinSeverity>;
  /** Behaviour when a code scanning (SAST) alert is created. */
  on_code_scanning_alert: SecurityAlertBehavior<CodeScanningMinSeverity>;
  /** Behaviour when a PR is opened, reopened, or marked ready for review. Disabled by default. */
  on_pr_opened: PROpenedBehavior;
  /** Behaviour when a reviewer submits an APPROVED review. Disabled by default. */
  on_pr_approved: PRApprovedBehavior;
}

export interface Config {
  server: ServerConfig;
  webhooks: WebhooksConfig;
  behavior: BehaviorConfig;
  /**
   * Project-specific code style guidelines prepended to every PR review notification.
   * Leave empty to omit. Use this to teach the agent your naming conventions,
   * formatting rules, preferred patterns, etc.
   */
  code_style: string;
}

// ── Hub Mode Types ─────────────────────────────────────────────────────────────

/**
 * Skill name overrides for a specific hub user.
 * Each key maps to the skill invoked for that event type.
 * Empty string means "use the server-level behavior default".
 */
export type HubSkillMap = Partial<
  Record<
    "on_pr_review" | "on_ci_failure" | "on_merge_conflict" | "on_pr_opened" | "on_pr_approved",
    string
  >
>;

/** Per-user fallback settings (override the hub-level defaults). */
export interface HubUserFallback {
  /** Whether the fallback worker is enabled for this user. Default: hub.fallback.enabled */
  enabled?: boolean;
  /** Milliseconds to wait for a claim before triggering fallback. Default: hub.fallback.timeout_ms */
  timeout_ms?: number;
  /**
   * Anthropic API key for this user's fallback invocations.
   * When set, fallback API calls are billed to this user's account instead of the hub's.
   * Falls back to the hub-wide ANTHROPIC_API_KEY env var if omitted.
   */
  anthropic_api_key?: string;
  /**
   * GitHub PAT for posting PR comments during fallback.
   * When set, comments appear as this user's GitHub account instead of the hub bot's.
   * Falls back to the hub-wide GITHUB_TOKEN env var if omitted.
   */
  github_token?: string;
}

/**
 * Per-user behavior overrides for hub mode.
 * Any key set here replaces (deep-merges over) the corresponding top-level behavior config.
 * Omitted keys fall back to the global behavior config from the YAML / defaults.
 */
export interface HubUserBehavior {
  /**
   * Per-user code style guidelines prepended to PR review notifications.
   * Replaces the global `code_style` for this user. Leave unset to inherit global.
   */
  code_style?: string;
  on_pr_review?: Partial<PRReviewBehavior>;
  on_ci_failure_main?: Partial<CIFailureBehavior>;
  on_ci_failure_branch?: Partial<CIFailureBehavior>;
  on_merge_conflict?: Partial<PRStateBehavior>;
  on_branch_behind?: Partial<PRStateBehavior>;
  on_pr_opened?: Partial<PROpenedBehavior>;
  on_pr_approved?: Partial<PRApprovedBehavior>;
  on_dependabot_alert?: Partial<SecurityAlertBehavior<DependabotMinSeverity>>;
  on_code_scanning_alert?: Partial<SecurityAlertBehavior<CodeScanningMinSeverity>>;
}

/**
 * A developer registered on the hub.
 * Admin configures these in the YAML; users connect with their token via Bearer auth.
 */
export interface HubUserProfile {
  /** GitHub login (case-sensitive) — used to route PR/CI events to this user. */
  github_username: string;
  /**
   * Pre-shared Bearer token for this user's MCP connection.
   * Generate with: openssl rand -hex 32
   */
  token: string;
  /** Per-event skill name overrides. Falls back to server-level behavior config. */
  skills?: HubSkillMap;
  /** Fallback worker settings for this user. */
  fallback?: HubUserFallback;
  /**
   * Per-user instruction and behavior overrides.
   * Any field set here replaces the corresponding global config value for this user's events.
   * Useful when different developers work on repos with different code styles or workflows.
   */
  behavior?: HubUserBehavior;
}

/**
 * Merge a user's per-user behavior overrides with the global Config.
 * Returns the global Config unchanged when the profile has no overrides.
 */
export function resolveUserConfig(
  globalConfig: Config,
  profile: HubUserProfile,
  sessionBehavior?: Partial<HubUserBehavior>,
): Config {
  let result = globalConfig;

  // Apply user-level behavior (from hub-config.yaml user.behavior — admin-controlled)
  if (profile.behavior) {
    const { code_style, ...behaviorOverrides } = profile.behavior;
    result = {
      ...result,
      code_style: code_style !== undefined ? code_style : result.code_style,
      behavior: deepMerge(result.behavior, behaviorOverrides as Partial<BehaviorConfig>),
    };
  }

  // Apply session-level behavior (from set_behavior tool — developer-controlled, highest priority)
  if (sessionBehavior) {
    const { code_style, ...behaviorOverrides } = sessionBehavior;
    result = {
      ...result,
      code_style: code_style !== undefined ? code_style : result.code_style,
      behavior: deepMerge(result.behavior, behaviorOverrides as Partial<BehaviorConfig>),
    };
  }

  return result;
}

/** Hub-wide fallback worker configuration. */
export interface HubFallbackConfig {
  /**
   * Whether to enable the fallback worker globally.
   * Can be overridden per user. Default: false.
   */
  enabled: boolean;
  /**
   * Milliseconds after dispatch with no claim before fallback fires.
   * Default: 900000 (15 minutes).
   */
  timeout_ms: number;
  /** Anthropic model ID used by the fallback worker. Default: "claude-sonnet-4-6" */
  model: string;
  /**
   * When true, the fallback worker posts a comment on the PR summarising what it did.
   * Default: true.
   */
  notify_via_pr_comment: boolean;
}

/**
 * Hub-mode configuration block.
 * Present only when running claude-beacon-hub; ignored by claude-beacon-mux.
 */
export interface HubConfig {
  /** Registered users. Must be non-empty; tokens must be unique. */
  users: HubUserProfile[];
  /** Global fallback defaults — overridden per user via user.fallback. */
  fallback: HubFallbackConfig;
}

const DEFAULT_HUB_FALLBACK: HubFallbackConfig = {
  enabled: false,
  timeout_ms: 15 * 60 * 1000,
  model: "claude-sonnet-4-6",
  notify_via_pr_comment: true,
};

// ── Defaults ──────────────────────────────────────────────────────────────────
// Mirrors the hardcoded behaviour that existed before the config system.
// Environment variables still take precedence over the YAML for server settings.

export const DEFAULT_CONFIG: Config = {
  server: {
    port: Number.parseInt(process.env.WEBHOOK_PORT ?? "9443", 10) || 9443,
    debounce_ms: Number.parseInt(process.env.REVIEW_DEBOUNCE_MS ?? "30000", 10) || 30_000,
    cooldown_ms: 5 * 60 * 1000,
    max_events_per_window: 50,
    main_branches: ["main", "master"],
    claim_ttl_ms: 10 * 60 * 1000,
    session_idle_ttl_ms: 30 * 60 * 1000,
    pending_ttl_ms: 2 * 60 * 60 * 1000,
  },
  webhooks: {
    allowed_authors: [],
    allowed_events: [],
    allowed_repos: [],
    skip_own_comments: true,
  },
  behavior: {
    worktrees: {
      mode: "temp",
      base_dir: "/tmp",
    },
    on_ci_failure_main: {
      upstream_sync: true,
      use_agent: true,
      instruction: [
        "Main branch is broken. Act immediately — no confirmation needed.",
        "{use_agent_preamble}",
        "Diagnose and fix the broken CI on main in {repo}:",
        "{health_check_step}",
        '1. Call fetch_workflow_logs("{run_url}") to read the failure',
        "2. Identify the failing step and root cause",
        "3. Apply a targeted fix in the codebase",
        "4. Commit and push to restore main",
        "5. Confirm CI is green.",
      ].join("\n"),
    },
    on_ci_failure_branch: {
      upstream_sync: true,
      use_agent: true,
      instruction: [
        "Act immediately — no confirmation needed.",
        "{use_agent_preamble}",
        "Investigate the CI failure on branch {branch} in {repo}:",
        "{health_check_step}",
        '1. Call fetch_workflow_logs("{run_url}") to read the failure',
        "2. Identify the root cause and fix it",
        "3. Push the fix to the branch.",
      ].join("\n"),
    },
    on_pr_review: {
      skill: "pr-comment-response",
      use_worktree: false,
      instruction: [
        "Act immediately — no confirmation needed.",
        "1. Call claim_notification first (see claim block below)",
        "2. Read full comments: gh pr view {pr_number} --repo {repo} --comments",
        "3. Apply fixes and commit",
        "4. Use the {skill} skill to post all replies in one shot",
      ].join("\n"),
    },
    on_merge_conflict: {
      instruction: [
        "PR #{pr_number} has merge conflicts with {base_branch}. Act immediately — no confirmation needed.",
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Resolve merge conflicts for PR #{pr_number} in {repo}:",
        "{worktree_steps}",
      ].join("\n"),
    },
    on_branch_behind: {
      instruction: [
        "PR #{pr_number} is behind {base_branch} (no conflicts). Act immediately — no confirmation needed.",
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Rebase PR #{pr_number} in {repo}:",
        "{worktree_steps}",
      ].join("\n"),
    },
    on_dependabot_alert: {
      enabled: false,
      min_severity: "medium",
      instruction: [
        "🚨 Dependabot alert on {repo}: {severity} vulnerability in {package} ({cve})",
        "Patched in: {patched_version}",
        "Details: {alert_url}",
        "",
        "Review the alert and update the dependency to the patched version.",
      ].join("\n"),
    },
    on_code_scanning_alert: {
      enabled: false,
      min_severity: "warning",
      instruction: [
        "🔍 Code scanning alert on {repo} ({branch}): {rule} [{severity}] via {tool}",
        "Details: {alert_url}",
        "",
        "Review the finding and apply a fix.",
      ].join("\n"),
    },
    on_pr_opened: {
      enabled: false,
      instruction: [
        'New PR #{pr_number} opened by {author}: "{pr_title}"',
        "Repo: {repo} | Branch: {head_branch} → {base_branch}",
        "URL: {pr_url}",
        "",
        "Review the PR and leave comments on any issues.",
      ].join("\n"),
    },
    on_pr_approved: {
      enabled: false,
      instruction: [
        'PR #{pr_number} "{pr_title}" has been approved by {reviewer}.',
        "Repo: {repo} | URL: {pr_url}",
        "",
        "The PR is approved — merge when ready or address any remaining tasks.",
      ].join("\n"),
    },
  },
  code_style: "",
};

// ── Worktree Step Builders ────────────────────────────────────────────────────

/**
 * Build the mode-appropriate steps for a rebase subagent.
 * The returned string replaces the {worktree_steps} placeholder in on_merge_conflict
 * and on_branch_behind instruction templates.
 */
export function buildWorktreeRebaseSteps(
  worktrees: WorktreeConfig,
  vars: { pr_number: string; head_branch: string; base_branch: string; repo: string },
  withConflicts: boolean,
): string {
  const { pr_number, head_branch, base_branch, repo } = vars;

  if (worktrees.mode === "native") {
    // Claude Code's Agent tool manages the worktree automatically when isolation="worktree"
    // is passed. The subagent starts directly inside the isolated worktree branch.
    const rebaseStep = withConflicts
      ? `2. git fetch origin && git rebase origin/${base_branch} — fix conflicts, then: git add -A && git rebase --continue`
      : `2. git fetch origin && git rebase origin/${base_branch}`;
    return [
      `Use the Agent tool with isolation="worktree" and these instructions for branch ${head_branch}:`,
      `1. You are already in an isolated worktree on branch ${head_branch}`,
      rebaseStep,
      `3. git push --force-with-lease origin ${head_branch}`,
    ].join("\n");
  }

  // Default: temp worktree via shell commands.
  // Path includes repo slug to prevent collisions when multiple repos share the same machine.
  const repoSlug = repo.split("/")[1] ?? repo;
  const worktreePath = `${worktrees.base_dir}/${repoSlug}-pr-${pr_number}-rebase`;
  const rebaseStep = withConflicts
    ? `3. git rebase origin/${base_branch} — fix conflicts, then: git add -A && git rebase --continue`
    : `3. git rebase origin/${base_branch}`;
  return [
    `1. git worktree add ${worktreePath} ${head_branch}`,
    `2. cd ${worktreePath} && git fetch origin`,
    rebaseStep,
    `4. git push --force-with-lease origin ${head_branch}`,
    `5. git worktree remove ${worktreePath}`,
  ].join("\n");
}

/**
 * Build the {worktree_preamble} for on_pr_review instructions.
 * Empty string when use_worktree=false; a directive sentence when true.
 */
export function buildWorktreePreamble(useWorktree: boolean): string {
  if (!useWorktree) return "";
  return (
    'You are running inside an isolated Claude Code worktree (isolation="worktree"). ' +
    "All file edits and commits apply directly to this worktree — no separate setup needed.\n\n"
  );
}

// ── Template Interpolation ────────────────────────────────────────────────────

/** Replace {key} placeholders in a template string. Unknown placeholders are left unchanged. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

// ── Deep Merge ────────────────────────────────────────────────────────────────

export function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val === undefined || val === null) continue;
    const baseVal = base[key];
    if (
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as object, val as object) as T[keyof T];
    } else {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

// ── Config Loader ─────────────────────────────────────────────────────────────

/**
 * Load a YAML config file and deep-merge it with DEFAULT_CONFIG.
 * Only the fields present in the file are overridden; everything else keeps its default.
 *
 * Environment variables still win over the YAML file for server.port and server.debounce_ms
 * because DEFAULT_CONFIG already reads them from process.env.
 *
 * @throws if the file is missing or contains invalid YAML / non-object content.
 */
export function loadConfig(filePath: string): Config {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  const parsed = parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file must be a YAML object: ${filePath}`);
  }
  return deepMerge(DEFAULT_CONFIG, parsed as Partial<Config>);
}

/**
 * Load a hub-mode YAML config file.
 * Returns both the base Config (deep-merged with defaults) and the HubConfig.
 *
 * Validates that:
 * - The file has a `hub.users` array with at least one entry
 * - Every user has a non-empty github_username and token
 * - All tokens are unique
 *
 * @throws if the file is invalid or hub.users fails validation.
 */
export function loadHubConfig(filePath: string): { config: Config; hub: HubConfig } {
  if (!existsSync(filePath)) {
    throw new Error(`Hub config file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  const parsed = parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Hub config file must be a YAML object: ${filePath}`);
  }
  const doc = parsed as Record<string, unknown>;

  // Extract and validate hub section
  const rawHub = doc.hub as Record<string, unknown> | undefined;
  if (!rawHub || typeof rawHub !== "object") {
    throw new Error(`Hub config missing required 'hub:' section in ${filePath}`);
  }

  const rawUsers = rawHub.users;
  if (!Array.isArray(rawUsers) || rawUsers.length === 0) {
    throw new Error(`hub.users must be a non-empty array in ${filePath}`);
  }

  const users: HubUserProfile[] = rawUsers.map((u: unknown, i: number) => {
    if (typeof u !== "object" || u === null) {
      throw new Error(`hub.users[${i}] must be an object`);
    }
    const user = u as Record<string, unknown>;
    if (typeof user.github_username !== "string" || user.github_username === "") {
      throw new Error(`hub.users[${i}].github_username must be a non-empty string`);
    }
    if (typeof user.token !== "string" || user.token === "") {
      throw new Error(`hub.users[${i}].token must be a non-empty string`);
    }
    if (user.token.length < 16) {
      throw new Error(
        `hub.users[${i}].token is too short (${user.token.length} chars, minimum 16). ` +
          "Generate a secure token with: openssl rand -hex 32",
      );
    }
    const skills = user.skills as HubSkillMap | undefined;
    const fallback = user.fallback as HubUserFallback | undefined;
    const behavior = user.behavior as HubUserBehavior | undefined;
    return {
      github_username: user.github_username as string,
      token: user.token as string,
      ...(skills !== undefined && { skills }),
      ...(fallback !== undefined && { fallback }),
      ...(behavior !== undefined && { behavior }),
    };
  });

  // Enforce unique tokens
  const seenTokens = new Set<string>();
  for (const user of users) {
    if (seenTokens.has(user.token)) {
      throw new Error(`hub.users contains duplicate token for user '${user.github_username}'`);
    }
    seenTokens.add(user.token);
  }

  // Merge hub-level fallback with defaults
  const rawFallback = (rawHub.fallback as Partial<HubFallbackConfig> | undefined) ?? {};
  const fallback: HubFallbackConfig = {
    enabled: rawFallback.enabled ?? DEFAULT_HUB_FALLBACK.enabled,
    timeout_ms: rawFallback.timeout_ms ?? DEFAULT_HUB_FALLBACK.timeout_ms,
    model: rawFallback.model ?? DEFAULT_HUB_FALLBACK.model,
    notify_via_pr_comment:
      rawFallback.notify_via_pr_comment ?? DEFAULT_HUB_FALLBACK.notify_via_pr_comment,
  };

  const hub: HubConfig = { users, fallback };

  // Also build the base config (without the hub section interfering with deepMerge)
  const { hub: _hub, ...docWithoutHub } = doc as { hub: unknown } & Record<string, unknown>;
  void _hub;
  const config = deepMerge(DEFAULT_CONFIG, docWithoutHub as Partial<Config>);

  return { config, hub };
}
