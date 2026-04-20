# Changelog

## [1.8.5] — 2026-04-21

### Fix
- `NotificationEventStore.replayEventsAfter` (hub + mux): when `lastEventId` is empty or unknown (new/reconnected SSE session with no `Last-Event-ID`), now replays **all** buffered events instead of returning early with `""`. Previously, any notifications sent while the SSE stream was down were silently lost the moment the client reconnected — the hub logged "Pushed to N session(s)" but the events were discarded. Each store is scoped to a single session, so replaying all is safe.
- `NotificationEventStore.storeEvent`: adds `[sse] no active stream — buffered event` log line so it is immediately visible in hub/mux output when an event is buffered rather than delivered.
- `sendChannelNotification`: renamed log from "Pushed to Claude" to "Queued for SSE" to clarify that the SDK accepted the call, not that Claude received it.
- Hub/mux delivery log: renamed "Pushed to N session(s)" to "Accepted by N session(s)" with a pointer to `[sse]` lines for actual delivery status.

## [1.8.4] — 2026-04-21

### Fix
- `on_pr_review` default: set `use_worktree: false` (was `true`) — the old default injected a false "You are running inside an isolated Claude Code worktree" preamble into the notification even though the receiving session is a normal session, not a worktree. This contradicted the claim block that follows (which tells Claude to check its branch and maybe create a worktree), causing Claude to stall without acting.
- `on_pr_review` instruction: replace "Plan before acting" language with "Act immediately — no confirmation needed." to match the directive style of other event handlers and prevent unintended plan-mode activation.
- Remove dead `require_plan` field from `PRReviewBehavior` interface and defaults (it was documented to add an `EnterPlanMode` directive but was never wired into instruction building).

## [1.8.3] — 2026-04-15

### Features
- **Hub `--author` mode**: `claude-beacon-hub --author YourGitHubUsername` now works without a YAML config file. Hub derives a stable Bearer token from `GITHUB_WEBHOOK_SECRET` via HMAC-SHA256 (`hmac(secret, "hub-token:<username>")`), prints the exact `claude mcp add --header "Authorization: Bearer <token>"` command on startup, and builds an in-memory single-user config. Token is deterministic across restarts — Claude Code only needs to be reconfigured when the webhook secret is rotated.
- **Hub as default Quickstart path**: README Quickstart now uses `claude-beacon-hub --author` (steps 5–6) instead of mux. Hub provides Bearer token auth, per-user/per-session behavior config, fallback worker, and scales to teams without reconfiguration.
- **Mux documentation extracted**: Full mux setup (start command, connect Claude Code, `allowed_authors` config) moved to `docs/mux-mode.md`. README "Other deployment modes" links there.

### Documentation
- README Quickstart: replace mux steps 5–6 with hub `--author` steps; update `.env` location note
- README Other deployment modes: replace full hub setup subsections with "Scaling to a team" callout + link to `docs/hub-mode.md`; replace mux subsection with one-liner + link to `docs/mux-mode.md`; remove standalone `allowed_authors` section (now a config table row)
- `package.json`: `start:hub` script updated to `--author YourGitHubUsername` example

## [1.8.2] — 2026-04-15

### Bug fixes

- **Hub `.env` loading**: hub now loads `.env` from the same directory as the `--config` file at startup, in addition to the CWD that Bun auto-loads. Fixes `GITHUB_WEBHOOK_SECRET` not being found when running the compiled `claude-beacon-hub` binary from a different directory.
- **Hub startup validation**: `GITHUB_WEBHOOK_SECRET` is now validated at process start with a fatal error and actionable message; previously the hub would start silently and reject every webhook at runtime.
- Export `loadDotEnv` from `src/hub.ts` to enable direct unit testing

## [1.8.1] — 2026-04-15

### Documentation
- Add `docs/security-model.md`: threat model table, protected surfaces (webhook receiver, MCP endpoint, API calls), attack surfaces, known limitations, and admin checklist
- `README.md`: clarify `.env` file location (fix #1 user confusion), mark `set_filter` step as REQUIRED with callout, add worktree feature status note, add GitHub App org-vs-repo install callout, add mux-vs-hub decision note
- `docs/github-app.md`: add §5a (org installation role table, Option A/B for non-owners) and §5b (permission acceptance flow — who gets notified, where to accept, what breaks until accepted); update troubleshooting entry to reference §5b

### Tests
- `src/__tests__/hub.test.ts`: add `loadDotEnv` test suite (7 cases: loads new vars, preserves existing vars, strips double/single quotes, skips comments/blanks, skips malformed lines, no-throw on missing file); add `bearerAuth` edge cases (empty token, header trimming behaviour, greedy `\\s+` behaviour, non-Bearer scheme)
- `src/__tests__/server.test.ts`: add webhook guard sequencing integration suite (4 cases: bad sig → 401, dedup on replay, oversized → 413 before sig check, error response does not echo request body); add token log truncation invariant tests (3 cases documenting the 8-char prefix and char-count-only logging contract)

## [1.8.0] — 2026-04-15

### Features

- **Hub mode** (`claude-beacon-hub`): company-wide multi-tenant MCP server where a single infrastructure instance routes GitHub webhook events to each developer's Claude Code sessions based on PR authorship
  - Bearer token auth per user; tokens configured in hub YAML, shared out-of-band with developers
  - 4-tier routing: Tier 0 PR author → user sessions, then repo+branch, repo wildcard, repo catch-all
  - Per-user skill overrides configurable server-side in YAML
  - `FallbackWorker`: when a user's sessions are offline, calls Anthropic SDK after `fallback.timeout_ms` and optionally posts a PR comment summary
  - `import.meta.main` guard ensures CLI block doesn't run when hub.ts is imported in tests
- Restructure README Quickstart to use GitHub App as primary path (covers all repos automatically); per-repo webhook moved to "Other deployment modes" as the single-repo alternative
- Add `docs/hub-mode.md`: full setup guide including reverse proxy config (nginx/Caddy), systemd unit, user onboarding, routing model, fallback worker, and security notes
- Add `hub:` section to `config.example.yaml`

## [1.7.1] — 2026-04-14

### Docs

- Add `docs/github-app.md`: step-by-step guide for deploying via a GitHub App (single webhook URL, org-level install covers all repos automatically)
- Add GitHub App entry to README "Other deployment modes" section

## [1.7.0] — 2026-04-10

### Features

- Per-event PR handlers: `on_pr_opened` and `on_pr_approved` with configurable instruction templates
- Version bump to 1.7.0
