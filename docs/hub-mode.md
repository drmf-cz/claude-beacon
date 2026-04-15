# Hub mode — company-wide multi-user deployment

`claude-beacon-hub` is a multi-tenant extension of the mux server. Instead of one developer running their own mux, a single hub instance serves an entire team or org. Each developer connects their Claude Code sessions with a personal Bearer token; events are routed to the right person based on PR authorship.

```
GitHub App webhook
        │
   :9443 (HMAC-verified webhook receiver)
        │
   [claude-beacon-hub]  ← runs once, admin-managed
        │
   :9444/mcp  ← exposed via HTTPS reverse proxy, Bearer auth per user
   ┌────┬────┬────┐
   │    │    │    │
Alice  Bob  Carol  …
(CC sessions — each authenticated with their own token)
```

---

## How it differs from the mux

| Feature | mux (`claude-beacon-mux`) | hub (`claude-beacon-hub`) |
|---|---|---|
| Users | Single developer (`--author`) | Multiple developers, configured in YAML |
| Auth | No auth (localhost only) | Bearer token per user |
| Network | localhost:9444 only | Any host (reverse proxy + HTTPS) |
| Event routing | Repo + branch matching | **PR author → user sessions** first, then repo/branch |
| Skill config | Server-wide defaults | Per-user override in YAML |
| Fallback | None | Anthropic SDK fallback worker when user is offline |

---

## Prerequisites

- All requirements from the [main Quickstart](../README.md#quickstart) (Bun, Claude Code ≥ 2.1.80, GitHub App)
- `ANTHROPIC_API_KEY` — if any user enables `fallback.enabled: true`
- A reverse proxy (nginx or Caddy) for HTTPS termination

---

## Setup

### 1. Create the hub config

Copy `config.example.yaml` and add a `hub:` section:

```yaml
# hub-config.yaml
webhooks:
  allowed_repos: []   # empty = all repos covered by the GitHub App

hub:
  fallback:
    enabled: false              # global default — override per user
    timeout_ms: 900000          # 15 min before fallback fires
    model: "claude-sonnet-4-6"
    notify_via_pr_comment: true

  users:
    - github_username: alice
      token: "tok_alice_abc123"   # openssl rand -hex 32
      skills:
        on_pr_review: "pr-comment-response"
      fallback:
        enabled: true

    - github_username: bob
      token: "tok_bob_def456"
      fallback:
        enabled: true
        timeout_ms: 600000    # 10 min for Bob
```

Generate tokens: `openssl rand -hex 32`

### 2. Start the hub

```bash
GITHUB_WEBHOOK_SECRET=<secret> GITHUB_TOKEN=<pat> ANTHROPIC_API_KEY=<key> \
  claude-beacon-hub --config hub-config.yaml
```

Or with a `.env` file (Bun auto-loads it from the working directory):

```bash
claude-beacon-hub --config hub-config.yaml
```

Output on startup:
```
[github-ci:hub] Loaded hub config from hub-config.yaml: 2 user(s)
[github-ci:hub] Hub users: alice, bob
[github-ci:hub] MCP HTTP server listening on http://0.0.0.0:9444/mcp
[github-ci:hub] Webhook server listening on http://localhost:9443
[github-ci:hub] Hub ready — waiting for Claude Code sessions and GitHub webhook events.
```

### 3. Set up the reverse proxy

The hub's MCP endpoint must be accessible over HTTPS. Configure nginx or Caddy to terminate TLS and proxy to `:9444`.

**nginx:**
```nginx
server {
    listen 443 ssl;
    server_name beacon.company.com;

    ssl_certificate     /etc/ssl/certs/beacon.pem;
    ssl_certificate_key /etc/ssl/private/beacon.key;

    location / {
        proxy_pass         http://localhost:9444;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        # Required for SSE — disables Nginx's default 60s read timeout
        proxy_read_timeout 0;
    }
}
```

**Caddy** (`Caddyfile`):
```
beacon.company.com {
    reverse_proxy localhost:9444
}
```

Caddy's default keepalive handles SSE correctly with no extra config.

### 4. Run as a systemd unit

```ini
# ~/.config/systemd/user/claude-beacon-hub.service
[Unit]
Description=claude-beacon hub server
After=network.target

[Service]
WorkingDirectory=/path/to/hub-config-dir
ExecStart=/home/admin/.bun/bin/claude-beacon-hub --config /path/to/hub-config.yaml
EnvironmentFile=/path/to/hub-config-dir/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-beacon-hub
journalctl --user -u claude-beacon-hub -f
```

---

## User onboarding

Admins share each user's token out-of-band. Each developer adds the hub to their Claude Code MCP config:

**`~/.mcp.json`:**
```json
{
  "mcpServers": {
    "claude-beacon": {
      "url": "https://beacon.company.com/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer tok_alice_abc123"
      }
    }
  }
}
```

Then follow the same steps as mux mode:

```bash
# Start Claude Code
claude --dangerously-load-development-channels server:claude-beacon

# Register session filter (or automate via ~/.claude/CLAUDE.md hook)
set_filter(
  repo="owner/repo",
  branch="feat/my-feature",
  label="feat/my-feature",
  worktree_path="/path/to/repo"
)
```

The hub confirms: `Filter registered for @alice: owner/repo@feat/my-feature.`

### CLAUDE.md hook (recommended)

Same as mux mode — add to `~/.claude/CLAUDE.md`:

```markdown
## GitHub CI Channel — session filter
When the claude-beacon MCP server connects, call `set_filter` immediately with:
- repo: run `git remote get-url origin` and parse to owner/repo
- branch: run `git branch --show-current`
- label: same as branch
- worktree_path: run `git rev-parse --show-toplevel`
```

---

## Routing model

When a GitHub webhook event arrives, the hub routes it as follows:

| Tier | Condition | Recipients |
|---|---|---|
| 0 | Event has a known PR author who is a registered hub user | That user's sessions (then Tier 1+2 within them) |
| 1+2 | Repo + exact branch match, or wildcard branch | Matching sessions across all users |
| 3 | Any session for the same repo (catch-all) | All repo sessions |
| — | No sessions at all | Queued for 2h + fallback worker fires |

**Example:** Alice pushes a commit; CI fails on her `feat/auth` branch. The hub:
1. Extracts `pr_author = "alice"` from the webhook's `sender` field
2. Finds Alice's sessions (Tier 0)
3. Within Alice's sessions, finds the one on `feat/auth` (Tier 1)
4. Delivers only to that session

If Alice has no sessions registered, the hub queues the notification (2h TTL) and starts the fallback timer.

---

## Fallback worker

When a user is offline and their sessions are unresponsive, the fallback worker:

1. Waits `fallback.timeout_ms` (default 15 min) for any session to claim the notification
2. If no claim arrives, calls the Anthropic API with the notification content
3. Posts a PR comment summarising what was done (if `notify_via_pr_comment: true`)
4. Queues a summary notification for when the user reconnects

Requires `ANTHROPIC_API_KEY` in the environment. The model can be configured per-hub (`fallback.model`).

**Example PR comment:**
```
> 🤖 claude-beacon fallback worker — @alice had no active sessions
>
> Rebased feat/auth onto main — conflicts resolved in auth/middleware.ts.
> Full response posted above.
```

To disable fallback entirely for a user:

```yaml
hub:
  users:
    - github_username: bob
      token: "..."
      fallback:
        enabled: false
```

---

## Security notes

### Token security

- Tokens are pre-shared secrets — protect them like API keys
- Rotate a token by updating `token:` in the YAML and restarting the hub; old token immediately rejected
- Tokens are never logged (only 8-char prefix of GITHUB_TOKEN is logged, not user tokens)
- Each session's `github_username` is bound at connection time from the token — cannot be spoofed by the client

### TLS

- The MCP endpoint (`:9444`) should never be exposed without TLS
- The webhook endpoint (`:9443`) must remain public for GitHub App delivery but is HMAC-protected

### `allowed_repos`

Restrict the hub to specific repos to limit blast radius:

```yaml
webhooks:
  allowed_repos:
    - myorg/backend
    - myorg/frontend
```

### Fallback worker scope

The fallback worker runs server-side with the hub's `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`. It can post PR comments and read workflow logs but cannot push code (read-only PAT is sufficient for all current operations).
