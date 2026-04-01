# claude-code-github-ci-channel

[![CI](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/drmf-cz/claude-code-github-ci-channel/actions/workflows/ci.yml)

> MCP channel plugin that pushes GitHub Actions CI/CD results directly into running Claude Code sessions.

When a CI run on one of your PRs fails, you get an instant notification inside Claude Code — with enough context to let Claude diagnose the failure, read logs, and suggest or apply a fix without you switching tabs.

Built on the [Claude Code Channels API](https://docs.anthropic.com/en/docs/claude-code/channels) (research preview, ≥ v2.1.80).

## How it works

```
GitHub Actions
     │  webhook (HMAC-SHA256)
     ▼
[cloudflared tunnel]  ←── runs locally, free, no account needed
     │
     ▼
HTTP server :9443    (this plugin, runs as MCP subprocess)
     │  parseWorkflowEvent()
     ▼
notifications/claude/channel
     │
     ▼
Claude Code session   ←── sees the failure, can call fetch_workflow_logs
```

The plugin runs as a sidecar process inside your Claude Code session (via stdio MCP transport). GitHub can't reach your laptop directly, so a tunnel (cloudflared or ngrok) bridges the gap. No cloud infrastructure, no always-on server.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1.0
- Claude Code ≥ 2.1.80
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (or ngrok)
- GitHub personal access token — scope: `repo` + `actions:read`

## Setup

### 1. Install the plugin

```bash
git clone https://github.com/drmf-cz/claude-code-github-ci-channel
cd claude-code-github-ci-channel
bun install
```

### 2. Generate a webhook secret

```bash
openssl rand -hex 32
# → e.g. a3f2c1d4e5b6...  (save this, you'll need it in two places)
```

### 3. Start the tunnel

```bash
# Option A — cloudflared (no account needed for temporary URLs)
cloudflared tunnel --url http://localhost:9443
# Output: https://random-name.trycloudflare.com  ← copy this URL

# Option B — ngrok
ngrok http 9443
# Output: https://xxxx.ngrok-free.app  ← copy this URL
```

Leave the tunnel running in a terminal tab.

### 4. Register the webhook on GitHub

1. Go to your repo → **Settings → Webhooks → Add webhook**
2. **Payload URL**: paste your tunnel URL (e.g. `https://random-name.trycloudflare.com`)
3. **Content type**: `application/json`
4. **Secret**: paste the value from step 2
5. **Which events**: choose *Let me select individual events*, then tick:
   - Workflow runs
   - Workflow jobs
   - Check suites
6. Click **Add webhook** — GitHub will send a ping and you should see a green ✓

### 5. Register with Claude Code

Add to `.mcp.json` in your project root (or `~/.mcp.json` for all projects):

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/index.ts"],
      "env": {
        "WEBHOOK_PORT": "9443",
        "GITHUB_WEBHOOK_SECRET": "your-secret-from-step-2",
        "GITHUB_TOKEN": "ghp_your_personal_access_token"
      }
    }
  }
}
```

See [`docs/mcp-json-example.json`](docs/mcp-json-example.json) for a full example.

### 6. Start Claude Code with channels enabled

```bash
claude --dangerously-load-development-channels server:github-ci
```

> Once channels graduate from research preview this flag will be replaced by `--channels github-ci`.

### Verify it works

Push a commit (or re-run a failed workflow). Within seconds you should see a channel message like:

```
[github-ci] ❌ FAILURE — CI · acme/myrepo · main · #42
Step failed: Run tests
→ fetch_workflow_logs to diagnose
```

Claude can then call the `fetch_workflow_logs` tool to pull the full log and suggest a fix.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEBHOOK_PORT` | No | `9443` | HTTP port for the webhook receiver |
| `GITHUB_WEBHOOK_SECRET` | Yes (prod) | — | HMAC-SHA256 secret — must match GitHub webhook settings |
| `GITHUB_TOKEN` | No | — | PAT with `actions:read` for `fetch_workflow_logs` |

If `GITHUB_WEBHOOK_SECRET` is unset, all webhook requests are accepted (dev mode — fine for localhost but not for production).

## Tunnel lifecycle

The tunnel URL changes every time you restart cloudflared (free tier). Each restart requires updating the GitHub webhook URL. To avoid this, either:

- Pin the URL with a free [Cloudflare account](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/tunnel-guide/) and a named tunnel
- Use [ngrok's static domains](https://ngrok.com/blog-post/free-static-domains-ngrok-users) (free tier, one domain)

## Development

```bash
bun test              # Run all tests
bun run typecheck     # TypeScript check
bun run lint          # Biome linter
bun run lint:fix      # Auto-fix lint issues
bun run build         # Build to dist/
```

## Documentation

- [AGENTS.md](AGENTS.md) — Architecture deep-dive, security notes, production deployment
- [docs/mcp-json-example.json](docs/mcp-json-example.json) — `.mcp.json` snippet
- [docs/channels-json-example.json](docs/channels-json-example.json) — `channels.json` snippet
- [docs/notify-claude.yml](docs/notify-claude.yml) — Optional: trigger from GitHub Actions workflow

## Option C: GitHub CLI Events watcher (no tunnel)

If you don't want to run a tunnel, `src/ghwatch.ts` polls the [GitHub Events API](https://docs.github.com/en/rest/activity/events) for completed `WorkflowRunEvent`s. It uses your existing `gh` CLI session — no extra token config needed.

```
GitHub Events API  ←── poll every ~60s (ETag + X-Poll-Interval respected)
        │
        ▼
[ghwatch.ts process]
        │  WorkflowRunEvent completed → parseWorkflowEvent()
        ▼
notifications/claude/channel
        │
        ▼
Claude Code session
```

**Trade-off vs webhooks:** GitHub's public events stream has ~30–60 s latency and only includes events on *public* repos (or private repos you have access to via the token). For instant notifications on private repos, use the webhook approach.

### Setup

```bash
# 1. Authenticate gh CLI (skip if already done)
gh auth login

# 2. Add to .mcp.json — use ghwatch.ts entrypoint instead of index.ts
```

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/ghwatch.ts"],
      "env": {
        "WATCH_REPOS": "owner/repo1,owner/repo2"
      }
    }
  }
}
```

If you prefer an explicit token over `gh auth` (e.g. in CI or a different machine):

```json
"env": {
  "WATCH_REPOS": "owner/repo1,owner/repo2",
  "GITHUB_TOKEN": "ghp_your_token"
}
```

```bash
# 3. Start Claude Code with channels enabled
claude --dangerously-load-development-channels server:github-ci
```

No GitHub webhook registration, no tunnel. Works out of the box if you already use `gh`.
