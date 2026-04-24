# Changelog

## [1.14.0] — 2026-04-21

### Features
- **Catch-all grant** (`src/hub.ts`): only ONE session per user can hold the catch-all grant at a time (first-claim-wins). `set_filter(branch=null)` claims the grant; switching to a specific branch releases it automatically. A new `release_catchall` tool allows explicit release. Stale holders (idle > `session_idle_ttl_ms / 2`) can be evicted by a new claimer. Grant is auto-released on disconnect. `get_status` now shows `catchall_grant: true/false` per session.
- **`get_behavior` tool** (`src/hub.ts`): lists effective behavior configuration per event type with source annotation (`[SQLite]` / `[config.yaml]` / `[global default]`), including instruction previews. Allows inspecting and auditing the current merged config before adjusting with `set_behavior`.
- **Full config reference** (`config.example.yaml`): documented all behavior fields under `hub.users[N].behavior` (all event types with all fields and placeholders), and catch-all grant semantics under `default_filter`.

### Fix
- **`check_run` / `check_suite` / `workflow_job` branch extraction** (`src/server.ts`, `src/types.ts`): these CI events previously fell through with `branch: null`, causing all repo sessions to receive them regardless of branch filter. Now extract `head_branch` from the webhook payload so events are routed to the correct branch session.
- **`on_pr_review` instruction** (`src/config.ts`): the default instruction now outputs the response table in the session (not to GitHub), explicitly says "STOP" before the approval gate, and references the skill by name rather than `/{skill}` (which was being auto-invoked instead of shown as text).
- **`set_behavior` persistence** (`src/hub.ts`, `src/store.ts`): behavior set via `set_behavior` is now persisted to SQLite (`session_behaviors` table) and restored automatically on session reconnect.

## [1.13.0] — 2026-04-21

### Features
- **Persistent pending queue** (`src/store.ts`, `src/hub.ts`): pending notifications now survive hub restarts via a new `pending_queue` SQLite table in the same database as session filters. On startup the hub restores the queue from SQLite; delivered items are deleted individually; expired items are purged every 5 minutes. Configurable via `server.pending_ttl_ms` — set up to `604800000` (7 days).

### Fix
- **`on_pr_review` instruction now shows a table and waits for approval** (`src/config.ts`, `config.example.yaml`): removed "Act immediately — no confirmation needed." from the default `on_pr_review` instruction. The new default presents a summary table of proposed changes/replies in the session and waits for explicit user approval before making any changes or posting to GitHub. The skill invocation now uses the slash-command form `/{skill}` so it is correctly invoked by Claude Code.
- **Debounce routing key locked to first event** (`src/server.ts`): `issue_comment` payloads have no `pull_request.head.ref`, so when `issue_comment` was the last event to extend the debounce window, its `branch=null` routing key overwrote the real PR branch and the notification was delivered to every session for that repo regardless of branch filter. The `onFire` callback is now stored in `PendingPRReview` at creation and reused on all timer extensions.

## [1.12.0] — 2026-04-21

### Features
- **PR review workflow split** (`src/hub.ts`, `src/config.ts`, `src/server.ts`): hub now routes PR review events differently depending on whether the receiving session belongs to the PR author or a reviewer:
  - **Author sessions** receive the existing `on_pr_review` instruction (read comments → fix code → push → reply).
  - **Reviewer sessions** (session `github_username` ≠ PR author) receive a new `on_pr_review_as_reviewer` instruction — produces a plan of proposed review responses for user approval, no code changes, no comments posted without approval.
- **`review_debounce_ms`** (`src/config.ts`): separate debounce for PR review events (default 60 s) vs general notifications (`debounce_ms`, 30 s). Gives GitHub more time to deliver all review comments before the notification fires.
- **Tier 3 catch-all restriction** (`src/hub.ts`): only `branch=null` sessions are eligible as catch-all recipients. Previously any repo-matched session (even with a specific branch filter) could receive events for other branches; now specific-branch sessions only receive their own branch's events.

### Fix
- `reviewer_summary` field on `CINotification` (`src/types.ts`): notifications carry both an author summary and a reviewer summary; hub routing selects the appropriate one per recipient session.

## [1.11.0] — 2026-04-21

### Fix
- **Per-worktree session filter persistence** (`src/store.ts`): the SQLite store now uses a composite `PRIMARY KEY (github_username, worktree_path)` instead of `github_username` alone. Previously, the last `set_filter` call from any session overwrote a single shared row, so after a hub restart every session for the same user got the wrong filter. Now each logical session location (identified by its worktree filesystem path) has its own independent row.
- **Safe multi-session restore** (`loadUniqueFilter`): on session reconnect, the hub restores the persisted filter only when the user has exactly one DB row (single-session user — unambiguous). If a user has two or more rows (multi-session), no restoration is attempted and the session starts with `default_filter` or null/null — the same behaviour as before persistence was added, but without the risk of applying another session's filter.
- **Schema migration**: `openFilterStore` now uses `PRAGMA user_version` to detect and migrate the v1.10.0 single-PK schema to the new composite-PK schema without requiring a manual DB deletion.

## [1.10.0] — 2026-04-21

### Features
- **Session filter persistence** (`src/store.ts`): hub sessions now persist their last `set_filter` values to a SQLite file (`hub-session-filters.db` next to the config). When the hub restarts and Claude Code auto-reconnects, the filter is restored automatically — no manual `set_filter` call needed. Priority: persisted filter > `default_filter` from config > null/null.
- `hub.session_store_path` config option: override the SQLite file location (useful for shared volumes or non-standard layouts).

## [1.9.0] — 2026-04-21

### Features
- `default_filter` in hub user profile: when set, a Claude session is automatically registered with the specified `repo`/`branch` filter the moment it connects — no explicit `set_filter` call needed. Useful for daemon / catch-all sessions (`branch: null` catches all branches). `set_filter` still works as an override to narrow or change the filter after connect.
- Log timestamps: all three log functions (`[github-ci]`, `[github-ci:hub]`, `[github-ci:mux]`) now include `HH:MM:SS.mmm` timestamps making it easy to correlate webhook arrival, SSE replay, and session events.
- SSE keep-alive pings: hub MCP server now injects `: ping\n\n` SSE comment lines every 25 seconds into all SSE streams, preventing reverse proxies (nginx default: 60 s read timeout) from silently closing idle connections.
- `config.example.yaml`: document `default_filter` in the hub users block with commented-out examples.

### Fix
- `lastActivityAt` is now updated when a notification is successfully delivered to a session, not only on incoming HTTP requests. Previously, sessions with an open SSE stream but no tool calls would be evicted by the idle TTL even while actively receiving events.
- Idle TTL eviction now closes the transport (`transport.close()`) so Claude Code receives a clean disconnect signal and reconnects. Previously, the transport was left open — SSE pings kept flowing but the hub had forgotten the session and could not route any notifications to it.

## [1.8.7] — 2026-04-21

### Features
- `server.session_idle_ttl_ms` (default: 30 min): configures how long a hub session can be idle before being evicted. Previously hardcoded. Increase to retain session registrations longer between Claude Code restarts.
- `server.pending_ttl_ms` (default: 2 hours): configures how long queued notifications are retained while waiting for a matching session. Previously hardcoded. Increase if you start Claude sessions infrequently.
- `config.example.yaml`: document both new fields with commented-out examples; fix stale `on_pr_review` example (was showing removed `require_plan` field and old plan-mode instruction).

## [1.8.6] — 2026-04-21

### Fix
- `buildReviewNotification`: PR review comment snippets increased from 120 → 400 chars so Claude sees enough context to act without fetching each comment URL individually.
- `on_pr_review` default instruction: step 2 now reads `gh pr view {pr_number} --repo {repo} --comments` instead of the vague "Open every linked comment URL" — gives Claude a concrete command to fetch full comment text.
- `buildReviewNotification`: passes `pr_number` and `repo` to instruction `interpolate()` so `{pr_number}` and `{repo}` are available as placeholders in user-configured `on_pr_review.instruction` templates.
- `hub.test.ts`: replace `delete process.env.X` with `Reflect.deleteProperty(process.env, "X")` to fix TypeScript 6.0 narrowing issue where `delete` permanently narrowed the property to `undefined` even after a function call restored it.

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
