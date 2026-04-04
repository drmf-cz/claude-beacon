# Changelog

All notable changes to `claude-beacon` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

---

## [1.2.0] — 2026-04-04

### Added
- `CLAUDE.md`: authoritative guide for AI agents — repo structure, security-first review checklist, TypeScript standards, commit and versioning conventions, merge checklist.
- `CONTRIBUTING.md`: contributor guide covering setup, security requirements, adding new event types, and reporting security issues.
- `docs/ARCHITECTURE.md`: design decisions and rationale for all major architectural choices (HMAC verification, LRU cache sizing, debounce window, mux mode, template interpolation, etc.).
- `.claude/commands/security-review.md`: Claude skill that performs a structured security audit of changes — input boundaries, auth paths, token handling, information leaks, replay/DoS guards.
- `.claude/commands/review-pr.md`: Claude skill for full PR review — security, TypeScript correctness, test coverage, linting, documentation, version bump, CHANGELOG.
- `CHANGELOG.md`: retroactively documented all releases from v0.x through v1.1.3.

---

## [1.1.3] — 2026-04-04

### Fixed
- Add mandatory `--author` flag to all direct-run README examples (missing from `bunx` invocations).

---

## [1.1.2] — 2026-04-03

### Changed
- Version bump required by CI version-bump-check enforcement.

---

## [1.1.1] — 2026-04-03

### Added
- CI: enforce that every merged PR bumps `package.json` version (`ci/version-bump-check`).

---

## [1.1.0] — 2026-04-03

### Added
- **Native worktree mode** (`behavior.worktrees.mode: "native"`): CI hooks now emit Agent tool directives with `isolation="worktree"` instead of raw shell commands when native mode is enabled.
- `on_pr_review.use_worktree` config field: when true, PR review notifications include a preamble telling Claude it is already inside an isolated worktree.
- `buildWorktreeRebaseSteps()` and `buildWorktreePreamble()` exported from `config.ts` for template interpolation.
- `{worktree_steps}` and `{worktree_preamble}` placeholders in default instruction templates.
- `[skip]` debug log messages at every silent-drop point so suppressed events say why.
- Comprehensive security hardening: Unicode bidi-override stripping in `sanitizeBody()`, sanitisation of `pr.title`, `pr.head.ref`, `pr.base.ref`, `job.name`, step names, reviewer comments.
- Expanded test suite: `parseReviewWebhookPayload` coverage, LRU eviction test, bidi-override sanitisation test, config edge cases (null YAML, array YAML, nested override).
- `fetch_workflow_logs` redirect fix: `redirect:"manual"` + unauthenticated second fetch for AWS S3 presigned URLs (GitHub's log storage).
- Diagnostic logging in `checkPRsAfterPush`: token prefix (first 8 chars) and full GitHub API error body on non-200 responses.
- AGENTS.md updated: accurate binary names, bunx example corrected, `--author` requirement documented.

### Fixed
- README placeholder table: `{workflow_name}` → `{workflow}`, `{run_id}` → `{run_url}`.
- `docs/multi-session.md`: stale binary names updated to `claude-beacon` / `claude-beacon-mux`.
- Config test: `Object.keys` loop over behavior hooks replaced with explicit array to avoid iterating `worktrees` (which has no `instruction` field).

---

## [1.0.0] — 2026-04-03

### Added
- Renamed project from `github-ci-channel` to `claude-beacon`.
- **Multi-session mux server** (`claude-beacon-mux`): single persistent HTTP process; all Claude Code sessions connect via Streamable HTTP transport. Replaces the hub+relay architecture.
- `--author` CLI flag and `webhooks.allowed_authors` config: mandatory filter — server refuses to start without at least one entry. Accepts GitHub usernames and email addresses (for Co-Authored-By bot-PR matching).
- `behavior.worktrees`, `behavior.on_ci_failure_main`, `behavior.on_ci_failure_branch`, `behavior.on_pr_review`, `behavior.on_merge_conflict`, `behavior.on_branch_behind` config fields with YAML deep-merge support.
- `config.example.yaml` with all supported fields and inline documentation.
- YAML config loader (`loadConfig()`) with deep merge against `DEFAULT_CONFIG`.
- Template interpolation (`interpolate()`) for `{repo}`, `{branch}`, `{run_url}`, `{workflow}`, `{status}`, `{commit}`, `{pr_number}`, `{pr_title}`, `{head_branch}`, `{base_branch}`, `{worktree_steps}`, `{worktree_preamble}`.
- PR review debounce: notifications batched over 30 s window, grouped by reviewer, with 5-minute cooldown per PR.
- `checkPRsAfterPush()`: after every push to a tracked branch, fetch open PRs and notify on merge conflicts or branch-behind state.
- `fetch_workflow_logs` MCP tool: fetches CI log from a GitHub Actions run URL.
- GitHub Events API watcher (`ghwatch.ts`, Option B): polls without a webhook/tunnel.
- Bun `idleTimeout: 0` on MCP HTTP server to prevent SSE connection drops.
- Replay protection via `isDuplicateDelivery()` (LRU cache of 1 000 delivery IDs).
- Payload size guard (`isOversized()`, limit 10 MB).
- `sanitizeBody()`: strips null bytes and truncates to `MAX_BODY_CHARS`.
- `WEBHOOK_DEV_MODE` env var: bypass signature verification for local development.
- npm package distribution with CI/CD publish workflow.

---

## [0.x] — Pre-release

Early development iterations: webhook-only mode, poll mode (later removed), PR conflict detection via push events, security hardening, Biome v2 linting, strict TypeScript configuration.
