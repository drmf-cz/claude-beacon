# Changelog

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
