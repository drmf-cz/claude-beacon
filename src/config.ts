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
}

export interface WebhooksConfig {
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
}

export interface CIFailureBehavior {
  /**
   * Instruction template appended to CI failure notifications.
   *
   * Available placeholders: {repo}, {branch}, {run_url}, {workflow}, {status}, {commit}
   */
  instruction: string;
}

export interface PRReviewBehavior {
  /**
   * Whether to require the agent to enter plan mode before applying any fixes.
   * When true the instruction should include an explicit EnterPlanMode directive.
   */
  require_plan: boolean;
  /** Skill name invoked during the execution phase. */
  skill: string;
  /**
   * Instruction text appended to PR review notifications.
   *
   * Available placeholders: {skill}  (replaced with the skill field above)
   * PR/reviewer context is already in the notification header — no PR variables needed here.
   */
  instruction: string;
}

export interface PRStateBehavior {
  /**
   * Instruction template for PRs in a conflict or behind state.
   *
   * Available placeholders: {repo}, {pr_number}, {pr_title}, {pr_url}, {head_branch}, {base_branch}
   */
  instruction: string;
}

export interface BehaviorConfig {
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
  },
  webhooks: {
    allowed_events: [],
    allowed_repos: [],
  },
  behavior: {
    on_ci_failure_main: {
      instruction: [
        "Main branch is broken. Act immediately — no confirmation needed.",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Diagnose and fix the broken CI on main in {repo}:",
        '1. Call fetch_workflow_logs("{run_url}") to read the failure',
        "2. Identify the failing step and root cause",
        "3. Apply a targeted fix in the codebase",
        "4. Commit and push to restore main",
        "5. Confirm CI is green.",
      ].join("\n"),
    },
    on_ci_failure_branch: {
      instruction: [
        "Act immediately — no confirmation needed.",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Investigate the CI failure on branch {branch} in {repo}:",
        '1. Call fetch_workflow_logs("{run_url}") to read the failure',
        "2. Identify the root cause and fix it",
        "3. Push the fix to the branch.",
      ].join("\n"),
    },
    on_pr_review: {
      require_plan: true,
      skill: "pr-comment-response",
      instruction: [
        "MANDATORY: Enter plan mode first.",
        "1. Read every linked thread and summarise what each one asks for",
        "2. Draft a plan listing the file + change for each thread",
        "3. Only after the plan is complete, use the {skill} skill to execute",
        "",
        "Do NOT apply any fix before the plan step is done.",
        "",
        "Execution phase:",
        "1. For each comment thread above, open the link and read full context",
        "2. Code comments: apply the fix in a worktree, commit",
        "3. Questions / style: reply inline with a concise explanation",
        "4. Use gh-pr-reply.sh --batch to post all replies in one shot",
      ].join("\n"),
    },
    on_merge_conflict: {
      instruction: [
        "PR #{pr_number} has merge conflicts with {base_branch}. Act immediately — no confirmation needed.",
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Resolve merge conflicts for PR #{pr_number} in {repo}:",
        "1. git worktree add /tmp/pr-{pr_number}-rebase {head_branch}",
        "2. cd /tmp/pr-{pr_number}-rebase && git fetch origin",
        "3. git rebase origin/{base_branch} -- fix conflicts, then: git add -A && git rebase --continue",
        "4. git push --force-with-lease origin {head_branch}",
        "5. git worktree remove /tmp/pr-{pr_number}-rebase",
      ].join("\n"),
    },
    on_branch_behind: {
      instruction: [
        "PR #{pr_number} is behind {base_branch} (no conflicts). Act immediately — no confirmation needed.",
        "",
        "Use the Agent tool NOW to spawn a subagent with these instructions:",
        "Rebase PR #{pr_number} in {repo}:",
        "1. git worktree add /tmp/pr-{pr_number}-rebase {head_branch}",
        "2. cd /tmp/pr-{pr_number}-rebase && git fetch origin",
        "3. git rebase origin/{base_branch}",
        "4. git push --force-with-lease origin {head_branch}",
        "5. git worktree remove /tmp/pr-{pr_number}-rebase",
      ].join("\n"),
    },
  },
  code_style: "",
};

// ── Template Interpolation ────────────────────────────────────────────────────

/** Replace {key} placeholders in a template string. Unknown placeholders are left unchanged. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

// ── Deep Merge ────────────────────────────────────────────────────────────────

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
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
