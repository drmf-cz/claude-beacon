# Security model

This document covers what claude-beacon protects, its attack surfaces, and what admins should know before deploying it in a production or team environment.

---

## Threat model

claude-beacon sits between GitHub (untrusted network input) and Claude Code (a trusted AI agent with shell access). The primary risks are forged or replayed webhook payloads reaching Claude and causing unintended actions.

| Threat | Mitigated by |
|---|---|
| Forged webhook (attacker pretends to be GitHub) | HMAC-SHA256 signature verification using `timingSafeEqual` |
| Replay attack (attacker resends a valid delivery) | Bounded LRU delivery-ID dedup set (last 1000 deliveries) |
| Oversized payload / DoS via large body | 20 MB body limit checked before any JSON parsing |
| Prompt injection via PR title / commit message / review body | `sanitizeBody()` strips null bytes, Unicode bidi-override characters, collapses whitespace |
| `GITHUB_TOKEN` forwarded to arbitrary hosts via redirects | `fetch_workflow_logs` follows 302 to presigned S3 URLs without forwarding the `Authorization` header |
| Unauthorized PR authors triggering Claude actions | `allowed_authors` allowlist enforced per-event before notification is emitted |
| Notification routed to wrong developer (hub mode) | Tier-0 PR-author routing; Bearer token scope is per-user |
| Hub starting without webhook secret configured | Fatal startup exit with actionable error message (since v1.8.1) |

---

## What is protected

### Webhook receiver (port 9443)

Every POST request passes through three guards in order before any processing occurs:

1. **`isOversized()`** — rejects bodies exceeding 20 MB (checked before parsing or signature verification).
2. **`verifySignature()`** — validates `X-Hub-Signature-256` using HMAC-SHA256 and `timingSafeEqual`. Returns `false` if `GITHUB_WEBHOOK_SECRET` is not set (unless `WEBHOOK_DEV_MODE=true`).
3. **`isDuplicateDelivery()`** — silently acknowledges (HTTP 200) requests whose `X-GitHub-Delivery` ID was already seen, without re-processing or re-notifying.

After the guards pass, all user-supplied string fields embedded in notifications (PR titles, review bodies, commit messages, package names, code scanning alert messages) are passed through `sanitizeBody()` before reaching `CINotification.summary`.

Fields that are only used as display links (e.g. `html_url`) are not interpolated into instruction text.

### MCP endpoint (port 9444 — hub mode only)

- Every request must carry `Authorization: Bearer <token>` matching a pre-configured user profile.
- Invalid or missing tokens receive HTTP 401 before any session is created.
- The regex `^Bearer\s+(.+)$/i` rejects requests with no token value after the scheme prefix.
- Tokens must be ≥ 16 characters; duplicates are rejected at config-load time.

### GitHub API calls

- `GITHUB_TOKEN` is sent only to `api.github.com`. Log-fetching redirects (GitHub → presigned S3 URLs) are followed without the `Authorization` header.
- Token value is never written to logs. Startup logs show: `GITHUB_TOKEN found: <first-8-chars>...` and `GITHUB_WEBHOOK_SECRET found (<N> chars)`.

---

## Attack surfaces

### Port 9443 — webhook receiver (internet-facing)

This port receives POST requests from GitHub's delivery infrastructure. In production:

- Restrict inbound traffic to [GitHub's webhook source IP ranges](https://api.github.com/meta) at the firewall or reverse proxy level.
- Do not expose this port directly; run it behind a tunnel (cloudflared) or a reverse proxy that enforces IP allowlisting.
- The HMAC signature is the primary trust boundary, but defence-in-depth through IP restriction reduces the attack surface further.

### Port 9444 — MCP endpoint (localhost in mux mode; HTTPS proxy in hub mode)

- **Mux mode**: 9444 is localhost-only with no auth. Restrict access at the OS level (no external exposure).
- **Hub mode**: 9444 must be behind an HTTPS reverse proxy. The raw HTTP port must not be externally reachable. See `docs/hub-mode.md` for nginx/Caddy examples.

### Config files

- `hub-config.yaml` contains user Bearer tokens in plaintext. Set `chmod 600 hub-config.yaml`.
- `.env` contains `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN`. Set `chmod 600 .env`.
- Do not commit either file to version control (both are in `.gitignore`).

### Prompt injection

`sanitizeBody()` is the boundary between untrusted content and Claude's instruction text. It removes:
- Null bytes (`\u0000`)
- Unicode bidi-override characters (`\u200B`–`\u200F`, `\u202A`–`\u202E`, `\u2066`–`\u2069`)
- Collapses all whitespace to single spaces
- Truncates to a configurable maximum length (default 500 characters)

The `allowed_authors` allowlist is the primary guard against malicious PR submissions: events from authors not in the list are dropped before notification is emitted.

---

## What is NOT protected

These are known limitations. Understand them before deploying.

**`ANTHROPIC_API_KEY` at OS level** — The fallback worker API key is present in the hub process environment. An attacker with OS-level access to the hub process (e.g. via shell access to the server) can read it. Protect the server itself.

**Bearer token in MCP client config** — The user's Bearer token appears in `~/.mcp.json` in plaintext. This is standard MCP behaviour. OS-level access to a developer's machine exposes their hub token.

**Content of workflow logs** — `fetch_workflow_logs` returns raw CI log text to Claude's context window. If your CI jobs print secrets (e.g. via `echo $SECRET`), Claude will see them. Audit your CI pipelines before enabling log fetching.

**Replay beyond 1000 deliveries** — The dedup set is bounded at 1000 entries and is in-memory only (cleared on restart). An attacker who can observe delivery IDs and trigger >1000 distinct deliveries before replaying an old one can bypass dedup. In practice, GitHub retries within minutes — this window is closed in normal operation.

**`WEBHOOK_DEV_MODE=true`** — This flag disables signature verification entirely. It must never be set in production. The hub performs no check for this flag at startup; it is your responsibility to ensure it is not set.

---

## Admin checklist

Before deploying to production, verify all of the following:

- [ ] `GITHUB_WEBHOOK_SECRET` is a freshly generated random value: `openssl rand -hex 32`. Not reused from another service.
- [ ] `.env` has `chmod 600` and is not committed to version control.
- [ ] `hub-config.yaml` has `chmod 600` and is not committed to version control.
- [ ] Port 9443 (webhook receiver) is firewall-restricted to [GitHub's webhook IP ranges](https://api.github.com/meta).
- [ ] Port 9444 (MCP endpoint, hub mode) is behind an HTTPS reverse proxy. The raw HTTP port is not externally reachable.
- [ ] `GITHUB_TOKEN` has only the minimum required scopes: Actions:Read + Pull requests:Read (fine-grained PAT), or `repo` (classic PAT for private repos).
- [ ] `WEBHOOK_DEV_MODE` is **not** set in any production environment file or systemd unit.
- [ ] CI pipelines do not print secret values to stdout/stderr — `fetch_workflow_logs` returns raw log text to Claude.
- [ ] Bearer tokens for hub users are ≥ 32 characters (16 is the enforced minimum; 32+ is recommended). Rotate tokens when a developer leaves the team.
