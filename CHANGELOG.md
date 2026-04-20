# Changelog

## [1.8.4] — 2026-04-20

### Fix
- `buildReviewNotification`: PR review comment snippets increased from 120 → 400 chars so Claude sees enough context to act without fetching each comment URL individually.
- `on_pr_review` default instruction: step 2 now reads `gh pr view {pr_number} --repo {repo} --comments` instead of the vague "Open every linked comment URL" — gives Claude a concrete command to fetch full comment text.
- `buildReviewNotification`: passes `pr_number` and `repo` to instruction `interpolate()` so `{pr_number}` and `{repo}` are available as placeholders in user-configured `on_pr_review.instruction` templates.
- `hub.test.ts`: replace `delete process.env.X` with `Reflect.deleteProperty(process.env, "X")` to fix TypeScript 6.0 narrowing issue where `delete` permanently narrowed the property to `undefined` even after a function call restored it.

## [1.8.3] — 2026-04-20

### Fix
- `NotificationEventStore.replayEventsAfter` (hub + mux): when `lastEventId` is empty or unknown (new/reconnected SSE session with no `Last-Event-ID`), now replays **all** buffered events instead of returning early with `""`. Previously, any notifications sent while the SSE stream was down were silently lost the moment the client reconnected — the hub logged "Pushed to N session(s)" but the events were discarded. Each store is scoped to a single session, so replaying all is safe.
- `NotificationEventStore.storeEvent`: adds `[sse] no active stream — buffered event` log line so it is immediately visible in hub/mux output when an event is buffered rather than delivered.
- `sendChannelNotification`: renamed log from "Pushed to Claude" to "Queued for SSE" to clarify that the SDK accepted the call, not that Claude received it.
- Hub/mux delivery log: renamed "Pushed to N session(s)" to "Accepted by N session(s)" with a pointer to `[sse]` lines for actual delivery status.

## [1.8.2] — 2026-04-20

### Fix
- `on_pr_review` default: set `use_worktree: false` (was `true`) — the old default injected a false "You are running inside an isolated Claude Code worktree" preamble into the notification even though the receiving session is a normal session, not a worktree. This contradicted the claim block that follows (which tells Claude to check its branch and maybe create a worktree), causing Claude to stall without acting.
- `on_pr_review` instruction: replace "Plan before acting" language with "Act immediately — no confirmation needed." to match the directive style of other event handlers and prevent unintended plan-mode activation.
- Remove dead `require_plan` field from `PRReviewBehavior` interface and defaults (it was documented to add an `EnterPlanMode` directive but was never wired into instruction building).

## [1.8.1] — 2026-04-15

### Documentation
- Add `docs/security-model.md`: threat model table, protected surfaces (webhook receiver, MCP endpoint, API calls), attack surfaces, known limitations, and admin checklist
- `README.md`: clarify `.env` file location (fix #1 user confusion), mark `set_filter` step as REQUIRED with callout, add worktree feature status note, add GitHub App org-vs-repo install callout, add mux-vs-hub decision note
- `docs/github-app.md`: add §5a (org installation role table, Option A/B for non-owners) and §5b (permission acceptance flow — who gets notified, where to accept, what breaks until accepted); update troubleshooting entry to reference §5b

### Tests
- `src/__tests__/hub.test.ts`: add `loadDotEnv` test suite (7 cases: loads new vars, preserves existing vars, strips double/single quotes, skips comments/blanks, skips malformed lines, no-throw on missing file); add `bearerAuth` edge cases (empty token, header trimming behaviour, greedy `\\s+` behaviour, non-Bearer scheme)
- `src/__tests__/server.test.ts`: add webhook guard sequencing integration suite (4 cases: bad sig → 401, dedup on replay, oversized → 413 before sig check, error response does not echo request body); add token log truncation invariant tests (3 cases documenting the 8-char prefix and char-count-only logging contract)

### Code
- Export `loadDotEnv` from `src/hub.ts` to enable direct unit testing
- `src/hub.ts` (carried from PR #42): load `.env` from config file directory at startup; fatal startup validation for `GITHUB_WEBHOOK_SECRET`

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
