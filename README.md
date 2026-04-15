# claude-beacon

[![CI](https://github.com/drmf-cz/claude-beacon/actions/workflows/ci.yml/badge.svg)](https://github.com/drmf-cz/claude-beacon/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/claude-beacon.svg)](https://www.npmjs.com/package/claude-beacon)

> MCP channel plugin that pushes GitHub Actions CI/CD results and PR events directly into running Claude Code sessions — triggering automatic investigation and remediation.

Built on the [Claude Code Channels API](https://docs.anthropic.com/en/docs/claude-code/channels) (research preview, ≥ v2.1.80).

## What it does

| GitHub event | Condition | What Claude does |
|---|---|---|
| `workflow_run` completed | failure on **main/master** | Fetches logs, diagnoses root cause, spawns subagent to fix and push |
| `workflow_run` completed | failure on feature branch | Fetches logs, spawns subagent to investigate and fix |
| `push` to **main/master** | open PRs exist | Checks each PR's merge status; notifies on `dirty` or `behind` |
| `pull_request` | `mergeable_state: dirty` | Spawns subagent to rebase and resolve conflicts |
| `pull_request` | `mergeable_state: behind` | Spawns subagent to rebase cleanly |
| `pull_request_review` submitted | any non-APPROVED state | Debounced 30 s, then plan mode + `pr-comment-response` skill |
| `pull_request_review_comment` / `issue_comment` | — | Accumulated in the same debounce window |
| `pull_request` opened/ready | opt-in (`on_pr_opened.enabled`) | Notifies on new PRs opened or marked ready for review |
| `pull_request_review` APPROVED | opt-in (`on_pr_approved.enabled`) | Separate handler — e.g. auto-merge trigger |
| `dependabot_alert` created | opt-in (`on_dependabot_alert.enabled`) | Notifies about CVE — review and bump the dependency |
| `code_scanning_alert` created | opt-in (`on_code_scanning_alert.enabled`) | Notifies about SAST finding — review and apply a fix |

> `push` events on main are the only way to detect PRs going `behind` — GitHub doesn't fire a `pull_request` event when the base branch advances. Pushing to a feature branch does **not** trigger PR checks.

---

## Quickstart

The recommended path is **hub mode** with a **GitHub App**: one App installation covers your entire org, and one persistent hub process routes events to your Claude Code sessions with Bearer token authentication.

**Requirements:** [Bun](https://bun.sh) ≥ 1.1.0 · Claude Code ≥ 2.1.80 · [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or [ngrok](https://ngrok.com)

### 1. Install

```bash
bun add -g claude-beacon
```

### 2. Set up secrets

```bash
openssl rand -hex 32   # generate a webhook secret — copy the output

echo 'GITHUB_WEBHOOK_SECRET=<paste-secret>' >> .env
echo 'GITHUB_TOKEN=<your-PAT>'             >> .env
```

`GITHUB_TOKEN` scopes: fine-grained → **Actions: Read** + **Pull requests: Read**; classic → `public_repo`.

> **Where should `.env` live?** Put it in the directory where you run `claude-beacon-hub` (Bun auto-loads `.env` from the working directory). For advanced YAML config mode, you can also place `.env` next to the `--config` file — the hub loads from both locations.

### 3. Start the tunnel

```bash
cloudflared tunnel --url http://localhost:9443
# → prints: https://random-name.trycloudflare.com  ← copy this URL
```

Keep the tunnel running. For a stable URL that survives restarts (recommended): [cloudflared named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) or [ngrok static domain](https://ngrok.com/blog-post/free-static-domains-ngrok-users).

### 4. Create and install a GitHub App

A GitHub App registers the webhook once at the org level — every repository is covered automatically.

Go to **github.com/settings/apps → New GitHub App** (or **your-org → Settings → Developer settings → GitHub Apps**) and fill in:

| Field | Value |
|---|---|
| **GitHub App name** | `claude-beacon` (or any name) |
| **Webhook → Active** | ✓ checked |
| **Webhook URL** | Your tunnel URL from step 3 |
| **Webhook secret** | The secret from step 2 |

Under **Repository permissions** set these to **Read-only**: Actions, Pull requests, Issues, Contents (and optionally Code scanning alerts, Dependabot alerts).

Under **Subscribe to events** tick: Workflow runs, Pull requests, Pull request reviews, Pull request review comments, Pull request review threads, Issue comments, Pushes.

Click **Create GitHub App**, then **Install App** → choose your account or org → **All repositories** → **Install**.

> **Org install requires org owner role.** If you are not an org owner, ask your admin to install the App at `github.com/organizations/<your-org>/settings/installations`, or install it under your personal account for your own repos only. See [docs/github-app.md §5a](docs/github-app.md#5a-organization-installation--who-can-do-what) for the full non-owner workflow.

See [docs/github-app.md](docs/github-app.md) for the full guide including permission details, event list, and webhook URL update commands.

> **Single-repo alternative:** If you only need one repository, skip the GitHub App and [register a webhook directly in that repo](#per-repo-webhook-single-repository) instead.

### 5. Start the hub

```bash
claude-beacon-hub --author YourGitHubUsername
```

> **`--author` is required.** The server refuses to start without it — it sets the GitHub identity events are routed to. Hub prints the exact `claude mcp add` command on startup — copy it.

Keep this running in a tmux pane or background terminal. See [docs/multi-session.md](docs/multi-session.md) for systemd setup.

### 6. Connect Claude Code

Run the command printed by the hub on startup:

```bash
claude mcp add --transport http claude-beacon http://127.0.0.1:9444/mcp \
  --header "Authorization: Bearer <token>"
```

The token is derived from your webhook secret — it stays the same across restarts, so this command only needs to be run once.

### 7. Start Claude Code

```bash
claude --dangerously-load-development-channels server:claude-beacon
```

You should see: `Listening for channel messages from: server:claude-beacon`

**Verify:** App settings → **Advanced → Recent Deliveries**. Trigger a push — green ✓ means it's working. In Claude, watch for `[claude-beacon]` log lines.

### 8. Authorize automatic actions

By default Claude pauses for confirmation before force-pushing or rebasing, even when the notification says "Act immediately". Add this block to `~/.claude/CLAUDE.md` to grant standing permission:

```markdown
## GitHub CI Channel — Automatic Actions
When the `claude-beacon` MCP channel sends a notification, you are pre-authorized to act without additional confirmation:
- Branch behind base: rebase onto base branch, git push --force-with-lease
- Merge conflicts: same rebase workflow, resolve conflicts
- CI failure on main: spawn subagent, fetch logs, diagnose, fix, push
- CI failure on feature branch: spawn subagent, fetch logs, fix, push
- PR review / comments: plan mode, address threads, reply with gh-pr-reply.sh --batch
The channel notification IS the permission. No additional confirmation needed.
```

### 9. Register the session filter (REQUIRED — without this, no notifications arrive)

> **This step is mandatory.** The hub has no route for your session until `set_filter` is called — events are queued silently for up to 2 hours. Adding the block below to your CLAUDE.md makes Claude call `set_filter` automatically on every session start.

The hub routes events by repo and branch. Add this to `~/.claude/CLAUDE.md` so Claude registers automatically on session start:

```markdown
## GitHub CI Channel — session filter
When the claude-beacon MCP server connects, call `set_filter` immediately with:
- repo: run `git remote get-url origin` and parse to owner/repo
- branch: run `git branch --show-current`
- label: same as branch
- worktree_path: run `git rev-parse --show-toplevel`
```

> **Optional — Stop hook:** When Claude exits while holding a work claim, other sessions wait up to 10 minutes before taking over. Add a `Stop` hook to `~/.claude/settings.json` that POSTs to `http://localhost:9444/release-claim` to release immediately. See [docs/multi-session.md](docs/multi-session.md) for the full snippet.

---

## Other deployment modes

### Per-repo webhook (single repository) {#per-repo-webhook-single-repository}

If you only need one repository, skip the GitHub App. Follow Quickstart steps 1–3, then go to Repo → **Settings → Webhooks → Add webhook**: set the payload URL to your tunnel URL, content type `application/json`, paste the secret, and select the same event types listed in [docs/github-app.md §3](docs/github-app.md#3-subscribe-to-webhook-events). Continue with Quickstart steps 5–9.

Trade-off: webhook URL must be updated manually when the tunnel restarts, and each new repo needs a separate registration.

### Standalone (single Claude session)

If you only ever run one Claude Code window, add `claude-beacon` as a subprocess MCP server in `~/.mcp.json` with `command` set to the absolute path of the binary, `args: ["--author", "YourGitHubUsername"]`, and `env` containing `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN`. Follow Quickstart steps 1–4 and 7–9; skip steps 5–6. Use `which claude-beacon` for the path.

### CLI Events watcher (no tunnel)

Polls the [GitHub Events API](https://docs.github.com/en/rest/activity/events) using your existing `gh` CLI session — no tunnel or webhook config needed.

Trade-offs: ~30–60 s latency · `WorkflowRunEvent` only (no PR or job events) · no behind-PR detection.

```json
{
  "mcpServers": {
    "claude-beacon": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/path/to/claude-beacon/src/ghwatch.ts"],
      "env": { "WATCH_REPOS": "owner/repo1,owner/repo2" }
    }
  }
}
```

### Scaling to a team

The Quickstart's `--author` flag is a single-user shortcut. To share one hub instance across multiple teammates, switch to a YAML config with one entry per user — each gets their own Bearer token and can have per-user behavior overrides. See [docs/hub-mode.md](docs/hub-mode.md) for the full setup guide including team config, reverse proxy (TLS), systemd, fallback worker, and daemon sessions.

### Mux (no Bearer auth, local only)

The predecessor to hub — runs without Bearer tokens, so any process on localhost can connect to `:9444`. Suitable for air-gapped setups or if you prefer not to manage tokens.

See [docs/mux-mode.md](docs/mux-mode.md) for setup.

---

## Multi-session coordination

When multiple Claude Code sessions receive the same notification, the claim API ensures only one acts:

```
claim_notification("<repo>:<branch>")
  → "ok"            — you have the lock, proceed
  → "already_owned" — you already hold it, continue
  → "conflict:X"    — session X claimed it first, stop
  → "expired"       — claim timed out, stop
```

Claims expire after 10 minutes (`server.claim_ttl_ms`). Release explicitly with `release_claim("<key>")` or automatically via the Stop hook (see [Quickstart step 9](#9-register-the-session-filter)).

If a webhook arrives before any session has called `set_filter`, the mux queues it (up to 50 events per repo, 2-hour TTL) and flushes it when a session registers.

---

## Configuration

All settings are optional — the defaults work for most setups. Pass a YAML file with `--config my-config.yaml` (or via `.mcp.json` args). Environment variables (`GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `WEBHOOK_PORT`, `REVIEW_DEBOUNCE_MS`) always override YAML.

```bash
cp config.example.yaml my-config.yaml   # start from the annotated template
claude-beacon-hub --author YourGitHubUsername --config my-config.yaml
```

### Server options

| Key | Default | Description |
|---|---|---|
| `server.port` | `9443` | HTTP port for the webhook receiver |
| `server.debounce_ms` | `30000` | Accumulate review events for this many ms before firing |
| `server.cooldown_ms` | `300000` | Suppress duplicate notifications for the same PR |
| `server.max_events_per_window` | `50` | Maximum review events buffered per debounce window |
| `server.main_branches` | `["main","master"]` | Branch names treated as production |
| `server.claim_ttl_ms` | `600000` | How long a work-context claim is held before expiring |

### Webhook filters

| Key | Default | Description |
|---|---|---|
| `webhooks.allowed_authors` | **required** | GitHub usernames and/or emails whose PRs trigger actions. In hub `--author` mode this is set automatically; explicit YAML config is needed for mux or multi-user hub setups. Email entries match `Co-Authored-By` trailers (useful when an AI agent authors PRs on your behalf). |
| `webhooks.allowed_events` | `[]` (all) | Allowlist of GitHub event types. Empty = accept all |
| `webhooks.allowed_repos` | `[]` (all) | Allowlist of repos as `"owner/repo"`. Empty = accept all |
| `webhooks.skip_own_comments` | `true` | Drop review events from `allowed_authors` to prevent Claude reply loops. Set `false` to let Claude react to your own PR comments |

### Behavior hooks

Each hook has an `instruction` template with `{placeholder}` substitution. Opt-in hooks default to `enabled: false`.

| Key | Triggered by | Flags |
|---|---|---|
| `behavior.on_ci_failure_main` | `workflow_run` failure on main | `upstream_sync`, `use_agent` |
| `behavior.on_ci_failure_branch` | `workflow_run` failure on feature branch | `upstream_sync`, `use_agent` |
| `behavior.on_pr_review` | PR review / comment events (debounced) | `require_plan`, `skill`, `use_worktree` |
| `behavior.on_merge_conflict` | PR with `mergeable_state: dirty` | — |
| `behavior.on_branch_behind` | PR with `mergeable_state: behind` | — |
| `behavior.on_pr_opened` | PR opened / ready for review | `enabled` (default `false`) |
| `behavior.on_pr_approved` | APPROVED review submitted | `enabled` (default `false`) |
| `behavior.on_dependabot_alert` | Dependabot CVE alert | `enabled` (default `false`), `min_severity` |
| `behavior.on_code_scanning_alert` | CodeQL / SAST alert | `enabled` (default `false`), `min_severity` |

`behavior.code_style` — free-form string prepended to every PR review notification. Describe your project's coding conventions here.

**Notable flags:**
- `use_agent` — `true` (default) spawns a subagent to fix CI, keeping the main session free. Set `false` to act inline.
- `upstream_sync` — `true` (default) rebases from main before diagnosing. Set `false` if main is frequently broken.
- `behavior.worktrees.mode` — `"temp"` (default, shell `git worktree add/remove`) or `"native"` (Claude Code `isolation="worktree"`). **Status:** `"temp"` is stable and production-ready. `"native"` is experimental — see [docs/worktree-integration.md](docs/worktree-integration.md) for current limitations.
- `behavior.worktrees.base_dir` — base directory for temporary worktrees (default `/tmp`). Path: `{base_dir}/{repo}-pr-{N}-rebase`.

> Security alert hooks broadcast to **all sessions** registered for the repo. Enable only on the single instance responsible for security triage to avoid multiple sessions racing on the same CVE.

Full placeholder reference is in `config.example.yaml` next to each hook.

---

## Troubleshooting

**MCP shows red / "Failed to reconnect"**  
Port 9443 is held by a previous session. Run `lsof -i :9443`, kill the PID, restart Claude Code.

**401 Unauthorized on webhooks**  
Secret mismatch. Check `GITHUB_WEBHOOK_SECRET` in `.mcp.json` exactly matches GitHub. A `.env` in the repo directory can shadow it — delete it or make both match.

**No notification when a PR falls behind**  
Ensure **Pushes** is ticked in GitHub webhook events and `GITHUB_TOKEN` is set. Note: only pushes to main/master trigger PR checks, not pushes to feature branches.

**Hub/mux sends to too many sessions**  
Stale sessions auto-expire after 30 minutes of inactivity. Restart the hub to clear them immediately.

**"bun: command not found" in MCP logs**  
Use the absolute path in `.mcp.json`: `"command": "/home/you/.bun/bin/bun"`. Find with `which bun`.

**`claude_desktop_config.json` vs `.mcp.json`**  
`~/.config/Claude/claude_desktop_config.json` is for Claude Desktop. `~/.mcp.json` / `.mcp.json` is for Claude Code CLI. `--dangerously-load-development-channels` reads from `.mcp.json`.

**Claude receives notifications but doesn't act automatically**  
The CLAUDE.md permissions block is missing — add it as described in [Quickstart step 8](#8-authorize-automatic-actions).

**No notifications ever arrive — checklist**
1. App → **Advanced → Recent Deliveries** → green ✓? If not, secret or URL is wrong.
2. Tunnel still running? Restart = new URL → update the App's Webhook URL in settings.
3. All required event types subscribed in App settings?
4. `--author` exactly matches the GitHub login of the PR author (case-sensitive).
5. Claude Code started with `--dangerously-load-development-channels server:claude-beacon`.
6. `set_filter` called in the session?

**GITHUB_TOKEN 401 on startup**  
The hub loads `.env` from its working directory, not your home directory. Confirm via the CWD log line at startup. For fine-grained tokens: resource owner must be the org, and the org must have approved the token.

---

## Development

```bash
bun test            # run tests
bun run typecheck   # tsc --noEmit
bun run lint        # Biome v2
bun run build       # bundle to dist/
```

**Security:** HMAC-SHA256 verification uses `timingSafeEqual` (constant-time). Raw payloads are never forwarded to Claude — only sanitized fields reach the notification. `GITHUB_TOKEN` is read-only. `GITHUB_WEBHOOK_SECRET` is required; set `WEBHOOK_DEV_MODE=true` to bypass in local dev only.

See [AGENTS.md](AGENTS.md) for the architecture reference and contributor guide.
