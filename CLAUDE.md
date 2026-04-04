# CLAUDE.md — claude-beacon

This file is the authoritative guide for AI agents (Claude Code) working in this repository.

## What this repo is

`claude-beacon` is a Claude Code MCP plugin that pushes GitHub CI/PR webhook events into live Claude Code sessions as actionable notifications. It bridges GitHub webhooks → HMAC-verified HTTP receiver → MCP `notifications/claude/channel` method → Claude Code session.

It is **not** a general web server. Every design decision optimises for: minimal attack surface, zero accidental data leaks, and notifications that Claude can act on autonomously.

## Repository structure

```
src/
├── index.ts      # Entrypoint: wires HTTP server + MCP stdio transport
├── mux.ts        # Multi-session entrypoint: persistent HTTP server, all sessions connect
├── server.ts     # Core: HMAC verification, event parsing, MCP server, fetch_workflow_logs
├── config.ts     # Config loading, deep merge, template interpolation
├── types.ts      # GitHub webhook payload interfaces
└── ghwatch.ts    # Option B: GitHub Events API poller (no webhook/tunnel)

src/__tests__/
├── server.test.ts  # All server.ts unit tests
└── config.test.ts  # Config loading and interpolation tests

docs/
├── ARCHITECTURE.md          # Design decisions and rationale
├── multi-session.md         # Mux server setup guide
└── worktree-integration.md  # Native worktree mode guide

.claude/
└── commands/                # Claude skills for contributors
    ├── review-pr.md
    └── security-audit.md
```

## Development workflow — ALWAYS follow this

**Every change goes on a branch. Every branch gets a draft PR before work starts.**

```bash
# 1. Create a branch from main
git checkout -b feat/your-feature   # or fix/..., docs/..., refactor/...

# 2. Open a draft PR immediately (before writing code)
gh pr create --draft --title "feat: short description" --body "## What\n\n## Why"

# 3. Work on the branch, push often
git push -u origin feat/your-feature

# 4. When ready, mark the PR ready for review
gh pr ready
```

Why draft PRs: CI runs on every push, the version-bump check enforces progress, and the branch is visible to collaborators.

## Code quality checks — run before every push

```bash
bun test            # All tests must pass
bun run typecheck   # Zero TypeScript errors
bun run lint        # Biome v2 — zero violations
bun run build       # Bundle must succeed
```

CI enforces all four. A failing CI on any non-draft PR blocks merge.

## Security-first review approach

Security review is **mandatory** on every PR that touches `src/`. Review in this order:

### 1. Input boundaries (highest priority)

- All data entering from webhook payloads must pass through `sanitizeBody()` before being embedded in notifications.
- Fields that reach Claude's context: `pr.title`, `pr.head.ref`, `pr.base.ref`, `workflow.name`, `job.name`, commit messages, reviewer comments.
- Any new field embedded in a notification must be sanitised.

### 2. Authentication paths

- `verifySignature()` must be the first gate — called before any payload parsing.
- `WEBHOOK_DEV_MODE` must only bypass verification in test environments, never production.
- Token handling: `GITHUB_TOKEN` must only be sent to `api.github.com`. Check any new `fetch()` call for redirect handling.

### 3. Information leaks

- The `/health` endpoint must return only `{"status":"ok","server":"claude-beacon"}`.
- No secrets, tokens, or user data in logs beyond the 8-char token prefix already in place.
- Error responses must not echo back request content.

### 4. Prompt injection

- Any new GitHub field embedded in `CINotification.content` or `ReviewNotification` is a potential injection vector.
- Sanitise: strip null bytes, Unicode bidi-override characters (U+200B–U+202E, U+2066–U+2069), and truncate to `MAX_BODY_CHARS`.
- Reference `sanitizeBody()` in `src/server.ts` for the current implementation.

### 5. Replay and DoS

- All webhook events must be checked with `isDuplicateDelivery()` before processing.
- Payload size checked with `isOversized()` before parsing JSON.

## TypeScript standards

- **Zero `any`** — enforced by Biome `noExplicitAny: error`.
- All function parameters and return types must be explicit.
- Use discriminated unions (e.g. `MergeableState`) — do not use `string` for fields with known values.
- `tsconfig.json` is maximally strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`) — do not relax any flag.

## Testing standards

- Every new exported function must have unit tests.
- Security-critical functions (`verifySignature`, `sanitizeBody`, `isDuplicateDelivery`, `isOversized`) require tests for both the happy path and the failure/edge-case path.
- New event parse functions must test: successful parse, unknown/skipped events, and sanitisation of user-controlled fields.
- Target: keep test count growing. The current count is shown in `AGENTS.md` — update it when you add tests.

## Commit message format

```
<type>: <imperative short description>

# Types: feat, fix, docs, refactor, test, ci, chore
# Examples:
feat: add support for check_run events
fix: sanitise workflow name before embedding in notification
docs: document prompt injection mitigations
```

## Versioning

Every merged PR **must** bump `package.json` version (enforced by CI). Use semantic versioning:
- `patch` (1.1.x): bug fixes, docs, tests, refactors with no behaviour change
- `minor` (1.x.0): new features, new config options
- `major` (x.0.0): breaking config changes, removed fields

Update `CHANGELOG.md` with every version bump.

## Merge checklist

Before marking a PR ready:
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated
- [ ] Security review done (see above) for any `src/` changes
- [ ] New config fields documented in both `README.md` and `config.example.yaml`
