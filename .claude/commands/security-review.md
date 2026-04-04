# Security Review — claude-beacon

Perform a security-focused review of the changes in the current PR or working tree.

## What to check

### 1. Input boundaries (highest priority)

Find every place where data from a GitHub webhook payload enters the codebase:

```bash
grep -n "payload\." src/server.ts | grep -v "//\|test"
grep -n "sanitizeBody" src/server.ts
```

For each field embedded in a notification string, verify:
- Is it passed through `sanitizeBody()` before use?
- Does `sanitizeBody()` strip null bytes AND Unicode bidi-override characters?
- Is the result truncated to `MAX_BODY_CHARS`?

Any field embedded in `CINotification.content` or a review notification that bypasses `sanitizeBody()` is a **HIGH** severity finding.

### 2. Authentication paths

```bash
grep -n "verifySignature\|WEBHOOK_DEV_MODE" src/server.ts
```

Verify:
- `verifySignature()` is called before any payload parsing.
- `WEBHOOK_DEV_MODE` only skips verification, does not skip other guards.
- No new endpoint or code path bypasses signature verification.

### 3. Token handling

```bash
grep -n "GITHUB_TOKEN\|Authorization\|fetch(" src/server.ts
```

For every `fetch()` call:
- Is the `Authorization` header only sent to `api.github.com`?
- Is `redirect: "manual"` used when following GitHub redirects (to prevent token forwarding to S3)?

### 4. Information leaks

```bash
grep -n "console\.\|log(" src/server.ts | grep -v "console.error\|console.warn"
```

- No secrets, tokens, or full user data in log output beyond the 8-char token prefix.
- The `/health` endpoint returns only `{"status":"ok","server":"claude-beacon"}`.
- Error responses do not echo back request content.

### 5. Replay and DoS

- `isDuplicateDelivery()` called before processing.
- `isOversized()` called before `JSON.parse()`.
- No new code path accepts the payload before these checks.

## Output format

Report findings grouped by severity:

**HIGH** — Data reaches Claude without sanitisation, auth bypass, token forwarded to untrusted host.
**MEDIUM** — Potential injection vector with partial mitigation, info leak that reveals non-public data.
**LOW** — Dev-mode risks, edge-case missing guard.
**INFO** — Style or defence-in-depth suggestions.

For each finding: file, line number, description, recommended fix.

If no findings: state explicitly "No security issues found in the reviewed diff."
