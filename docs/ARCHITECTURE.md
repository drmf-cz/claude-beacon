# Architecture and Design Decisions

This document explains the significant design decisions in `claude-beacon` and the reasoning behind them. It is intended for contributors and anyone evaluating whether to trust or extend the system.

---

## High-level architecture

```
GitHub ──webhook──► Bun HTTP (WEBHOOK_PORT)
                         │
                    HMAC-SHA256 verify
                         │
                    parse event → CINotification
                         │
                    MCP stdio / Streamable HTTP
                         │
                    Claude Code session
                         │
                    notifications/claude/channel
```

Two transport layers share a single Bun process:
- **HTTP** on `WEBHOOK_PORT` (default 9443): receives GitHub webhook POSTs.
- **MCP (stdio or HTTP)**: communicates with Claude Code.

---

## Decision: Bun over Node.js

**Why Bun:**
- Single-binary runtime with a built-in HTTP server, test runner, and TypeScript support — no build step needed to run source directly.
- `Bun.CryptoHasher` and `timingSafeEqual` are available without extra dependencies.
- `bun install` is faster in CI.

**Trade-off:** Bun is not Node.js. Some npm packages behave differently. We import from `node:crypto`, `node:fs`, `node:os` explicitly to document which Node.js compatibility layer we rely on.

---

## Decision: HMAC-SHA256 with `timingSafeEqual`

GitHub signs every webhook payload with `HMAC-SHA256` using the secret configured in the webhook settings. We verify this with Node.js `crypto.timingSafeEqual` — a constant-time comparison that prevents timing oracle attacks.

**Why `timingSafeEqual`:** A naive `===` comparison short-circuits on the first mismatched byte. An attacker can measure response latency to determine how many prefix bytes of their forged signature matched. `timingSafeEqual` takes the same time regardless.

**Secret freshness:** The secret is read from `process.env.GITHUB_WEBHOOK_SECRET` on every call, not cached at module load. This means tests can override it via `process.env` without mocking, and an environment variable rotation takes effect on the next request without a restart.

---

## Decision: LRU delivery ID cache (size 1 000)

`isDuplicateDelivery()` tracks `X-GitHub-Delivery` headers in a `Set`. When the set reaches 1 000 entries, the oldest entry is evicted via `Set.values().next().value`.

**Why 1 000:** GitHub can retry a webhook up to 3 times with the same delivery ID over a few minutes. 1 000 entries covers thousands of events with minimal memory footprint. A time-based expiration would require a timer; a size-based LRU is simpler, deterministic, and testable.

**Risk:** If 1 001 unique deliveries arrive before a retry, the oldest delivery ID is evicted and a retry would not be detected as a duplicate. Acceptable — GitHub delivery IDs are UUIDs (128-bit random), and legitimate retries happen seconds after the original, not after 1 000 other events.

---

## Decision: 10 MB payload size limit

`isOversized()` rejects any body larger than 10 MB. The GitHub webhook payload for a large PR with many reviews is typically a few KB. 10 MB is generous enough to handle any realistic payload while preventing memory exhaustion from a malicious client that streams a gigabyte of data before disconnecting.

The original limit was 25 KB, raised to 10 MB when we discovered that workflow job payloads for repos with many matrix jobs could exceed 25 KB.

---

## Decision: Notifications as directives, not alerts

`CINotification.content` is injected verbatim into the Claude Code session as a new message. Claude reads it and is expected to act on it autonomously.

Early versions used passive language ("CI failed on main"). These produced no action from Claude — the model treated them as FYIs. We switched to imperative language and specific instructions:

```
❌ CI FAILURE — main — acme/repo
Act immediately — no confirmation needed.
Use the Agent tool NOW to spawn a subagent...
```

This is a deliberate UX decision: the plugin is designed for users who trust Claude to act autonomously on CI events. Users who want review-before-action should either customise the instruction templates or not use this plugin.

---

## Decision: 30-second debounce for PR reviews

When multiple review comments arrive in a short window (e.g., a reviewer leaves 5 comments on the same PR), we debounce notifications to 30 seconds and batch them into a single notification.

**Why 30 s:** This is the typical time for a reviewer to finish writing a review on GitHub and submit it. Below 30 s, batching is incomplete and Claude gets partial information. Above 60 s, the lag is noticeable.

**Why 50 events cap:** The debounce window accumulates events in memory. At 50 events (configurable via `max_events_per_window`), the batch fires early to bound memory usage and notification size. A PR with 50 review comments in one sitting is unusual and the cap is unlikely to trigger in practice.

**5-minute cooldown:** After a notification fires for a PR, no further notifications are sent for that PR for 5 minutes. This prevents a loop where Claude's automated replies trigger more webhook events that trigger more notifications.

---

## Decision: `allowed_authors` is mandatory

The server refuses to start without at least one entry in `allowed_authors`. This is intentional.

**Without author filtering:** every CI event in every repository connected to the webhook would trigger a notification, regardless of who authored the PR. For shared CI infrastructure, this would be noise. More seriously, a CI failure in an unrelated PR by another team member would interrupt an unrelated Claude session.

**Co-author matching:** some users work via AI pair programmers (e.g., Devin) that create PRs under a bot account. Their contribution appears in commit trailers as `Co-Authored-By: user@example.com`. We support email-format entries in `allowed_authors` for this case.

---

## Decision: YAML config with deep merge, not flat env vars

Early versions configured everything via environment variables. As the number of configurable fields grew (5 behavior hooks × 2-3 fields each), the env-var interface became unwieldy.

`loadConfig()` deep-merges a YAML file against `DEFAULT_CONFIG`. This means:
- Fields absent from the YAML keep their defaults.
- Users only specify what they want to change.
- The config is version-controlled alongside the project.

Environment variables (`WEBHOOK_PORT`, `REVIEW_DEBOUNCE_MS`) still take precedence over YAML because `DEFAULT_CONFIG` reads them from `process.env` — this is a deliberate escape hatch for containerised deployments.

---

## Decision: Template interpolation, not code

Notification instruction strings use `{placeholder}` syntax instead of code-level function calls. This lets users customise notification text in YAML without writing TypeScript.

`interpolate()` is intentionally minimal: it replaces `{key}` with `vars[key]`, leaving unknown placeholders unchanged. There is no conditionals, loops, or escaping — it is not a template language, just a string substitution.

---

## Decision: Explicit field extraction, no raw payload dump

The notification content is built from a fixed set of extracted fields (`repo`, `branch`, `pr.title`, etc.). The raw webhook JSON is never embedded in a notification.

**Why:** Raw payloads contain many user-controlled fields. Even with sanitisation, a raw dump significantly increases the attack surface for prompt injection. Explicit field extraction limits what can reach Claude's context.

---

## Decision: Mux mode (Streamable HTTP) over per-session stdio

The original design spawned a new `claude-beacon` subprocess per Claude Code session (stdio transport). This meant:
- Each session had its own HTTP server on a different port.
- Webhook routing to the right session was impossible without a hub/relay process.

We replaced this with a single `claude-beacon-mux` process on a fixed port (`:9444`) using the Streamable HTTP transport. All Claude Code sessions connect to it. The mux tracks which sessions to notify.

**Trade-off:** The mux is a persistent process that must be kept running (systemd or similar). In exchange, it eliminates the hub/relay complexity and makes webhook routing trivial.

---

## Decision: `fetch_workflow_logs` with manual redirect

GitHub Actions log URLs (`/repos/{owner}/{repo}/actions/runs/{run_id}/logs`) return an HTTP 302 redirect to a presigned AWS S3 URL. The S3 URL does not accept the `Authorization` header — it authenticates via query-string parameters.

If we follow the redirect automatically with the `Authorization` header, S3 rejects the request (`400 Bad Request: only one auth mechanism`).

Solution: `redirect: "manual"` to capture the redirect, then make an unauthenticated fetch to the S3 URL. This is the pattern GitHub's own clients use.

---

## Security model summary

| Threat | Mitigation |
|---|---|
| Forged webhook from non-GitHub source | HMAC-SHA256 verification, `timingSafeEqual` |
| Webhook replay attack | LRU delivery ID deduplication |
| Oversized payload (memory exhaustion) | 10 MB size guard before JSON parse |
| Prompt injection via PR title / commit message | `sanitizeBody()` strips null bytes, bidi-override characters, truncates |
| Token exfiltration via redirect | `redirect:"manual"`, unauthenticated S3 fetch |
| Credential leak in logs | Only 8-char token prefix logged |
| Dev-mode bypass in production | Explicit `WEBHOOK_DEV_MODE` env var required; logs a warning |
| Session flooding from high-volume repos | Debounce + per-PR cooldown + event cap |
