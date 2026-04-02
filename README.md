# claude-code-github-ci-channel

[![CI](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml)

> MCP channel plugin that pushes GitHub Actions CI/CD results and PR merge conflicts directly into running Claude Code sessions — triggering automatic investigation and remediation.

Built on the [Claude Code Channels API](https://docs.anthropic.com/en/docs/claude-code/channels) (research preview, ≥ v2.1.80).

## What it does

When a CI run completes or a PR gets a merge conflict, the plugin pushes an actionable notification into your active Claude Code session. Claude reads it as a directive and acts:

| Event | Condition | Claude does |
|---|---|---|
| `workflow_run` completed | failure on **main/master** | Fetches logs, diagnoses root cause, spawns subagent to fix and push |
| `workflow_run` completed | failure on feature branch | Fetches logs, spawns subagent to investigate |
| `workflow_run` completed | success | Silent acknowledgement |
| `pull_request` opened/synced | `mergeable_state: dirty` | Spawns subagent to rebase and resolve conflicts |
| `pull_request` opened/synced | `mergeable_state: behind` | Spawns subagent to rebase cleanly |
| `pull_request` opened/synced | `clean` / `unknown` / `blocked` | Silently skipped |

The notification content **is the prompt** — it contains explicit tool calls and subagent instructions that Claude executes immediately.

## Architecture

```
GitHub Actions / PR event
        │  HMAC-SHA256 signed webhook
        ▼
[cloudflared tunnel]  ←── runs locally, free, no account needed
        │  forwards to localhost:9443
        ▼
HTTP server :9443       (this plugin — runs as MCP subprocess inside Claude Code)
        │  verifySignature → isActionable → parse*Event
        ▼
notifications/claude/channel
        │  content = actionable instruction
        ▼
Claude Code session  ←── reads directive, calls fetch_workflow_logs, spawns subagents
```

Two additional modes without a tunnel — see [Option B](#option-b-github-cli-events-watcher-no-tunnel) below.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1.0
- Claude Code ≥ 2.1.80
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (for webhook mode) or `gh` CLI (for watcher mode)
- GitHub personal access token — scopes: `repo` + `actions:read`

## Option A: Webhook + Tunnel (recommended)

Real-time, all event types including `workflow_job` and `check_suite`.

### 1. Install

```bash
git clone https://github.com/drmf-cz/claude-code-github-ci-channel
cd claude-code-github-ci-channel
bun install
```

### 2. Create `.env`

```bash
cp .env.example .env
# Edit .env — fill in GITHUB_WEBHOOK_SECRET and GITHUB_TOKEN
```

```ini
WEBHOOK_PORT=9443
GITHUB_WEBHOOK_SECRET=          # generate: openssl rand -hex 32
GITHUB_TOKEN=                   # PAT with repo + actions:read
```

> **Important:** the values in `.env` and in your GitHub webhook settings **must match exactly**. A mismatch causes all webhooks to return 401.

### 3. Start the tunnel

```bash
# cloudflared (no account needed for temporary URLs)
cloudflared tunnel --url http://localhost:9443
# → prints: https://random-name.trycloudflare.com  ← copy this
```

Leave it running. Each restart gives a new URL — update the GitHub webhook URL when that happens.
To get a stable URL: [Cloudflare named tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) (free account) or [ngrok static domains](https://ngrok.com/blog-post/free-static-domains-ngrok-users).

### 4. Register webhook on GitHub

1. Repo → **Settings → Webhooks → Add webhook**
2. **Payload URL**: your tunnel URL
3. **Content type**: `application/json`
4. **Secret**: your `GITHUB_WEBHOOK_SECRET` value
5. **Events** — select individual events and tick:
   - ✅ Workflow runs
   - ✅ Workflow jobs
   - ✅ Check suites
   - ✅ Pull requests  ← required for merge conflict notifications
6. **Add webhook** — you should see a green ✓ ping response

### 5. Register with Claude Code

Create or update `.mcp.json` (project-level) or `~/.mcp.json` (global):

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "/path/to/.bun/bin/bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/index.ts"],
      "env": {
        "WEBHOOK_PORT": "9443",
        "GITHUB_WEBHOOK_SECRET": "your-secret",
        "GITHUB_TOKEN": "ghp_your_token"
      }
    }
  }
}
```

Use the **full path** to `bun` — Claude Code spawns processes without your shell PATH. Find it with `which bun`.

### 6. Start Claude Code

```bash
claude --dangerously-load-development-channels server:github-ci
```

You should see:
```
Listening for channel messages from: server:github-ci
```

---

## Option B: GitHub CLI Events watcher (no tunnel)

Polls the GitHub Events API every ~60 s. No tunnel, no webhook setup — just `gh auth login`.

**Trade-off:** ~30–60 s latency; only `WorkflowRunEvent` available (no `workflow_job` or PR events).

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "/path/to/.bun/bin/bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/ghwatch.ts"],
      "env": {
        "WATCH_REPOS": "owner/repo1,owner/repo2"
      }
    }
  }
}
```

Auth: uses `gh auth token` automatically, or set `GITHUB_TOKEN` explicitly.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEBHOOK_PORT` | No | `9443` | HTTP port for the webhook receiver |
| `GITHUB_WEBHOOK_SECRET` | Yes (prod) | — | HMAC-SHA256 secret — must match GitHub webhook settings exactly |
| `GITHUB_TOKEN` | No | — | PAT with `actions:read` for `fetch_workflow_logs` tool |
| `WATCH_REPOS` | Option B only | — | Comma-separated `owner/repo` list for Events API watcher |

If `GITHUB_WEBHOOK_SECRET` is unset, all requests are accepted (dev mode). A warning is logged.

---

## Troubleshooting

### MCP shows red / "Failed to reconnect"

**Most likely cause: port 9443 already in use.** Claude Code spawns the server as a subprocess. If a previous session left a stale process, the new one fails to bind and the MCP connection dies.

```bash
# Find and kill the stale process
lsof -i :9443
kill <PID>
# Then restart Claude Code
```

The server now emits a clear diagnostic: `ERROR: Port 9443 is already in use.`

### All webhooks return 401 Unauthorized

The HMAC signature doesn't match — the server and GitHub are using different secrets. This happens when:

1. **`.env` and GitHub webhook have different secrets.** Bun auto-loads `.env` from the working directory. If `.env` has a different value than what's configured in GitHub webhook settings, every request fails.
   - Fix: ensure `GITHUB_WEBHOOK_SECRET` in `.env` matches exactly what you pasted into GitHub.

2. **`GITHUB_WEBHOOK_SECRET` set in shell environment.** If the variable is exported in your shell, it overrides `.env`. Unset it or ensure consistency.

### "bun: command not found" in MCP logs

Claude Code spawns processes without your interactive shell PATH. Bun installs to `~/.bun/bin/bun` which may not be in the PATH MCP uses.

Fix: use the **absolute path** in `.mcp.json`:
```json
"command": "/home/you/.bun/bin/bun"
```

### Config file confusion: `claude_desktop_config.json` vs `.mcp.json`

- `~/.config/Claude/claude_desktop_config.json` — Claude **Desktop** (GUI app)
- `~/.mcp.json` or `.mcp.json` — Claude Code **CLI** (`claude` command)

The `claude --dangerously-load-development-channels server:github-ci` command reads from `.mcp.json`. Changes to `claude_desktop_config.json` have no effect on the CLI.

### Tunnel URL changed, webhooks stopped arriving

Cloudflared free tier generates a new random URL on each restart. Update the GitHub webhook payload URL: Repo → Settings → Webhooks → Edit → update URL. For a stable URL use a named Cloudflare tunnel or ngrok static domain.

---

## Development

```bash
bun test              # Run all 31 tests
bun run typecheck     # TypeScript strict check
bun run lint          # Biome linter (v2)
bun run lint:fix      # Auto-fix
bun run build         # Build to dist/
```

## Security notes

- **HMAC-SHA256** with `timingSafeEqual` — constant-time comparison prevents timing attacks
- **`.env` is gitignored** — never commit real secrets
- **Fallback handler** does not echo raw webhook payload — prevents prompt injection from crafted GitHub events
- **`GITHUB_TOKEN` scope** — use a fine-grained PAT with `actions:read` only; no write access needed
- **Dev mode** — if `GITHUB_WEBHOOK_SECRET` is unset, all requests are accepted and a warning is logged; never run without a secret in production

## Documentation

- [AGENTS.md](AGENTS.md) — Architecture deep-dive, security analysis, deployment guide
- [docs/mcp-json-example.json](docs/mcp-json-example.json) — `.mcp.json` snippet
- [docs/channels-json-example.json](docs/channels-json-example.json) — channels config example
