# Multiplexer — Hub + Relay Architecture

> **Problem:** Each Claude Code session spawns the MCP server as a subprocess.
> All subprocesses fight for the same port (`:9443`), so only the first session
> gets webhook events; every other session is silently ignored.
>
> **Solution:** Split the server into two processes — a single **hub** that owns
> the port, and one lightweight **relay** per Claude Code session. The hub routes
> each event to the relay(s) whose current repo and branch match the event.

---

## Architecture

```
                        GitHub webhook
                             │
                             ▼
                    ┌─────────────────┐
                    │   Hub process   │  ← runs once, not managed by MCP
                    │  :9443 (HTTP)   │
                    │  /tmp/ghci-hub  │  ← Unix domain socket
                    │    .sock        │
                    └────────┬────────┘
                             │  line-delimited JSON
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         ┌─────────┐   ┌─────────┐   ┌─────────┐
         │ Relay A │   │ Relay B │   │ Relay C │
         │ MCP sub │   │ MCP sub │   │ MCP sub │  ← one per Claude Code
         │ process │   │ process │   │ process │    session
         └────┬────┘   └────┬────┘   └────┬────┘
              │              │              │
         CC session A   CC session B   CC session C
         repo: foo       repo: foo      repo: bar
         branch: main    branch: feat/x branch: main
```

The hub is a long-running process you start **once** (e.g. in a tmux pane, or
as a systemd unit). Each Claude Code session starts its own relay via the normal
`.mcp.json` mechanism. The relay auto-detects the repo and branch from `git` in
its working directory and registers those as routing filters with the hub.

---

## Event routing

Each incoming webhook event carries a `(repo, branch)` routing key extracted by
the hub before forwarding. The hub sends the notification to a relay if:

| Hub routing key | Relay filter | Match? |
|---|---|---|
| `foo/bar @ feat/x` | `repo=foo/bar branch=feat/x` | ✅ exact |
| `foo/bar @ feat/x` | `repo=foo/bar branch=null` | ✅ relay watches all branches |
| `foo/bar @ feat/x` | `repo=null branch=null` | ✅ wildcard relay |
| `foo/bar @ feat/x` | `repo=foo/bar branch=main` | ❌ branch mismatch |
| `foo/bar @ feat/x` | `repo=baz/qux branch=feat/x` | ❌ repo mismatch |

Routing key extraction per event type:

| Event | Routing branch |
|---|---|
| `workflow_run` | Run's `head_branch` |
| `pull_request` | PR's head branch (`pull_request.head.ref`) |
| `pull_request_review` / `_comment` / `_thread` | PR's head branch |
| `issue_comment` on a PR | PR's head branch |
| `push` → PR behind/dirty (async check) | Each affected PR's head branch |
| Everything else | `null` (broadcast to all relays for the repo) |

This means: if you have a PR open from `feat/login` and you're actively working
on it in session A, only session A gets notified when a review comment arrives
or the branch goes behind.

---

## Setup

### 1. Start the hub (once)

The hub is a standalone Bun script — **do not** put it in `.mcp.json`.

```bash
# Basic
bun run /path/to/claude-code-github-ci-channel/src/hub.ts

# With a config file
bun run /path/to/claude-code-github-ci-channel/src/hub.ts \
  --config /path/to/my-config.yaml

# Custom socket path
GHCI_HUB_SOCKET=/run/user/1000/ghci-hub.sock \
  bun run src/hub.ts
```

The hub binds `:9443` for GitHub webhooks and
`/tmp/ghci-hub.sock` for relay connections. Both paths are configurable.

Recommended: run the hub in a dedicated tmux pane, or as a systemd user unit
(see [Running as a systemd unit](#running-as-a-systemd-unit)).

### 2. Configure each Claude Code session to start a relay

Replace the `src/index.ts` entry in your `.mcp.json` with `src/relay.ts`:

```json
{
  "mcpServers": {
    "github-ci": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/path/to/claude-code-github-ci-channel/src/relay.ts"],
      "env": {
        "GITHUB_TOKEN": "your-pat",
        "GHCI_HUB_SOCKET": "/tmp/ghci-hub.sock"
      }
    }
  }
}
```

> `GITHUB_WEBHOOK_SECRET` stays in the **hub** (it verifies webhook signatures);
> relays never see raw webhook payloads so they don't need it.
> `GITHUB_TOKEN` is needed by relays only if you use the `fetch_workflow_logs`
> MCP tool — omit it otherwise.

### 3. Start Claude Code normally

```bash
claude --dangerously-load-development-channels server:github-ci
```

The relay process auto-detects the current repo and branch from `git` in its
working directory (the directory Claude Code was started from). You should see
in the relay's stderr:

```
[github-ci:relay] Relay a1b2c3d4 | repo=myorg/myrepo branch=feat/login
[github-ci:relay] Connected to hub at /tmp/ghci-hub.sock
[github-ci:relay] Registered with hub as relay a1b2c3d4
[github-ci:relay] MCP channel connected to Claude Code
```

---

## Branch tracking

When you switch branches inside a session (e.g. `git checkout main`) the relay
detects the change within **30 seconds** (configurable via `BRANCH_POLL_INTERVAL_MS`)
and sends a heartbeat to the hub. The hub updates the relay's routing filter
without requiring a reconnection.

---

## Reconnection

If the hub restarts, all relays reconnect automatically with exponential backoff
(5 s → 10 s → 20 s … up to 60 s). Any events the hub receives while a relay is
disconnected are not buffered — they are dropped for that relay.

---

## Hub logs

The hub logs to stderr:

```
[github-ci:hub] Relay socket listening at /tmp/ghci-hub.sock
[github-ci:hub] Webhook server listening on http://localhost:9443
[github-ci:hub] Hub ready. Waiting for relays and webhook events.
[github-ci:hub] Relay connected: a1b2c3d4 (total: 1)
[github-ci:hub] Relay a1b2c3d4 registered: repo=myorg/myrepo branch=feat/login
[github-ci:hub] Received: workflow_run (completed) delivery=abc-123
[github-ci:hub] Routed to 1 relay(s): myorg/myrepo@feat/login
```

When no relay matches an event:

```
[github-ci:hub] No relay matched myorg/myrepo@feat/x — notification dropped
```

This is expected if no active Claude Code session is watching that branch.

---

## Running as a systemd unit

Save as `~/.config/systemd/user/ghci-hub.service`:

```ini
[Unit]
Description=github-ci-channel hub
After=network.target

[Service]
ExecStart=/home/you/.bun/bin/bun run /path/to/src/hub.ts --config /path/to/my-config.yaml
Environment=GITHUB_WEBHOOK_SECRET=your-secret-here
Environment=GITHUB_TOKEN=your-pat-here
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ghci-hub
journalctl --user -u ghci-hub -f   # tail logs
```

---

## Comparison: standalone vs hub+relay

| | Standalone (`src/index.ts`) | Hub + relay |
|---|---|---|
| Sessions supported | 1 | Unlimited |
| Port conflicts | Yes — second session fails to bind | No — hub owns the port |
| Repo/branch routing | N/A | Per-relay, auto-detected |
| Branch change tracking | N/A | Every 30 s via heartbeat |
| Hub needs to run separately | No | Yes |
| Existing `CLAUDE.md` permissions | Unchanged | Unchanged |
| Config file (`--config`) | Supported | Hub only; relays inherit hub's config |
| `fetch_workflow_logs` tool | Available | Available (needs `GITHUB_TOKEN` in relay env) |

---

## Protocol reference

Communication between hub and relay uses **line-delimited JSON** over a Unix
domain socket. Each message is a single JSON object followed by `\n`.

### Relay → Hub

```typescript
// Sent once on connect
{ type: "register", relay_id: string, repo: string | null, branch: string | null }

// Sent on branch change, or in response to a hub ping
{ type: "heartbeat", branch: string | null }
```

### Hub → Relay

```typescript
// Sent once after a valid register message
{ type: "registered", relay_id: string }

// A notification routed to this relay
{ type: "notify", notification: CINotification, routing: { repo: string, branch: string | null } }

// Keepalive — relay should respond with a heartbeat within 60 s
{ type: "ping" }
```

Relays that do not respond within 90 seconds (3 × ping interval) are removed
from the registry and their socket is closed.
