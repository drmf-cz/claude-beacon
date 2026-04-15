# Changelog

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
