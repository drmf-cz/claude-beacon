# Review PR — claude-beacon

Review the current PR for correctness, security, and compliance with project standards.

## Steps

### 1. Security review first

Run the `/security-review` skill on the changed files. This is mandatory for any PR touching `src/`.

### 2. TypeScript correctness

```bash
bun run typecheck
```

Zero errors required. Report any new `any` casts or type assertions without a justifying comment.

### 3. Test coverage

For every new exported function in the diff:
- Is there a corresponding test in `src/__tests__/`?
- Does the test cover the happy path AND at least one error/edge-case path?
- For security-critical functions (`verifySignature`, `sanitizeBody`, `isDuplicateDelivery`, `isOversized`): are both success and failure paths tested?

```bash
bun test
```

All tests must pass.

### 4. Linting

```bash
bun run lint
```

Zero Biome violations. Auto-fixable issues should be fixed with `bun run lint:fix` before review.

### 5. Documentation

- New config fields: documented in both `README.md` (YAML config reference section) and `config.example.yaml`.
- New event types: documented in `README.md` (events table) and `AGENTS.md` (key exports table).
- Breaking changes: noted in `CHANGELOG.md` under the correct version.

### 6. Version bump

```bash
grep '"version"' package.json
git log --oneline main..HEAD | grep -i "bump\|version"
```

Every merged PR must increment `package.json` version. Confirm the bump is present.

### 7. CHANGELOG

`CHANGELOG.md` must have an entry for the version being bumped. Check that:
- The version number matches `package.json`.
- The entry lists added, changed, and fixed items accurately.
- The date is today's date in ISO format.

## Output format

Summarise findings in sections matching the steps above. For each issue: file, line number, description.

End with one of:
- **APPROVE** — All checks pass, no issues found.
- **REQUEST CHANGES** — List blocking issues that must be fixed before merge.
- **COMMENT** — Non-blocking suggestions.
