# Worktree integration — research and design

## Problem

The current automatic-action instructions hardcode a "temp worktree" pattern:

```
1. git worktree add /tmp/pr-{pr_number}-rebase {head_branch}
2. cd /tmp/pr-{pr_number}-rebase && git fetch origin
3. git rebase origin/{base_branch}
4. git push --force-with-lease origin {head_branch}
5. git worktree remove /tmp/pr-{pr_number}-rebase
```

Many developers work **natively in worktrees** — every branch lives in its own
persistent directory rather than a single checkout. For these users:

- The PR branch worktree already exists. Creating a temp duplicate at `/tmp/` is
  wrong and potentially conflicts with the real one.
- Custom tooling (e.g. Gas Town's `gt sling`, project-specific scripts) spawns
  worktrees with specific naming and directory conventions that Claude must
  respect.
- The subagent spawned for CI fixes or conflict resolution needs to land in the
  **right directory**, not invent one.

---

## Three usage patterns

| Pattern | Who | How worktrees work |
|---|---|---|
| **Temp** (default) | Single-checkout users | No persistent worktrees; create `/tmp/pr-N-rebase` for each PR action, remove after |
| **Native** | Worktree-first users | Each branch already has a worktree; find it with `git worktree list` and use it |
| **Custom spawn** | Teams with tooling | A project script creates worktrees: `gt sling {pr_number}`, `make worktree branch={branch}`, etc. |

---

## Detection options

### Option A — Auto-detect at instruction time (Claude-side)

The notification instruction asks Claude to detect the worktree situation before
acting. No config required.

```
Before creating a worktree, check whether the branch already has one:
  git worktree list --porcelain | grep -B1 "branch refs/heads/{head_branch}"
If a path is found, cd there. Otherwise create a temp:
  git worktree add /tmp/pr-{pr_number}-rebase {head_branch}
```

**Pros:** Zero config; always accurate.  
**Cons:** Adds reasoning steps to every instruction; detection logic lives in a
prompt string (fragile), not in code.

### Option B — YAML config section

A new `behavior.worktrees` block tells the mux exactly what to do.

```yaml
behavior:
  worktrees:
    mode: temp          # temp | native | custom
    create_cmd: "..."   # mode=custom only
    cleanup_cmd: "..."  # mode=custom only; empty = no cleanup
```

The plugin interpolates worktree-specific placeholders
(`{worktree_path}`, `{worktree_create_cmd}`, `{worktree_cleanup_cmd}`) into
the instruction templates at notification-build time.

**Pros:** Explicit; predictable; fully configurable.  
**Cons:** Requires one-time setup.

### Option C — `set_filter` extension (per-session)

Extend `set_filter` to carry worktree metadata from each Claude Code session:

```
set_filter(
  repo="owner/repo",
  branch="feat/x",
  worktree_mode="native",
  worktree_create_cmd="gt sling {pr_number} myrig"
)
```

The mux stores this per-session and uses it when building the notification
sent to that specific session.

**Pros:** Per-session; different sessions can have different modes.  
**Cons:** Requires updating `CLAUDE.md` snippet; harder to implement correctly
(the notification must be tailored per-session, not per-repo).

---

## Recommended approach: Option B + smart default

### Phase 1 — Smart auto-detect (low effort, immediate value)

Replace the hardcoded `/tmp/pr-N-rebase` step in the default
`on_merge_conflict` and `on_branch_behind` instructions with a two-step that
detects existing worktrees first:

```
Rebase PR #{pr_number} in {repo}:
1. Find existing worktree: run `git worktree list --porcelain` and look for
   a line `branch refs/heads/{head_branch}`. If found, cd to that path.
   If not found, create a temp: git worktree add /tmp/pr-{pr_number}-rebase {head_branch}
2. git fetch origin && git rebase origin/{base_branch}
   (for conflicts: git add -A && git rebase --continue for each conflict)
3. git push --force-with-lease origin {head_branch}
4. If you created a temp worktree (step 1): git worktree remove /tmp/pr-{pr_number}-rebase
```

This handles native-worktree users with **no config**, just a smarter default
instruction. The existing YAML override mechanism means users who don't want
this detection can write their own `on_branch_behind.instruction`.

### Phase 2 — `behavior.worktrees` config (full control)

Add a `worktrees` section to `BehaviorConfig` and `config.example.yaml`:

```yaml
behavior:
  worktrees:
    # How to obtain a worktree when acting on a PR branch.
    #
    #   temp    Create /tmp/pr-{pr_number}-rebase; remove when done. (default)
    #   native  Find the existing worktree with `git worktree list`. Error if not found.
    #   custom  Run create_cmd; run cleanup_cmd when done (empty = no cleanup).
    mode: temp

    # Used when mode=custom. Available placeholders: {pr_number}, {head_branch},
    # {base_branch}, {repo}
    #
    # Gas Town example:  gt sling {pr_number} myrig
    # Make example:      make worktree BRANCH={head_branch}
    create_cmd: ""

    # Cleanup command. Runs after push. Leave empty to skip.
    # Example: gt worktree remove {pr_number}
    cleanup_cmd: ""
```

**New template placeholders** resolved at notification-build time:

| Placeholder | `mode=temp` | `mode=native` | `mode=custom` |
|---|---|---|---|
| `{worktree_acquire}` | `git worktree add /tmp/pr-{pr_number}-rebase {head_branch}` then `cd /tmp/...` | `cd $(git worktree list --porcelain \| grep ...)` | Configured `create_cmd` |
| `{worktree_release}` | `git worktree remove /tmp/pr-{pr_number}-rebase` | _(nothing)_ | Configured `cleanup_cmd` |

The default `on_merge_conflict` and `on_branch_behind` instructions are
rewritten to use these placeholders. Users who override the instruction
manually can still use them too.

#### Type additions to `config.ts`

```typescript
export type WorktreeMode = "temp" | "native" | "custom";

export interface WorktreeConfig {
  mode: WorktreeMode;
  /** Shell command to create/enter a worktree. mode=custom only. */
  create_cmd: string;
  /** Shell command to remove the worktree after the action. mode=custom only. */
  cleanup_cmd: string;
}

export interface BehaviorConfig {
  // ... existing fields ...
  worktrees: WorktreeConfig;
}
```

#### Interpolation changes in `server.ts`

`buildWorktreeSteps(config)` → returns `{ acquire: string; release: string }`
based on `config.behavior.worktrees.mode`. These are added to the placeholder
map for `on_merge_conflict` and `on_branch_behind`:

```typescript
function buildWorktreeSteps(
  config: Config,
  vars: { pr_number: string; head_branch: string },
): { acquire: string; release: string } {
  const w = config.behavior.worktrees;
  const path = `/tmp/pr-${vars.pr_number}-rebase`;
  switch (w.mode) {
    case "native":
      return {
        acquire: `cd $(git worktree list --porcelain | grep -B1 "refs/heads/${vars.head_branch}" | head -1)`,
        release: "",
      };
    case "custom":
      return {
        acquire: interpolate(w.create_cmd, vars),
        release: w.cleanup_cmd ? interpolate(w.cleanup_cmd, vars) : "",
      };
    default: // temp
      return {
        acquire: `git worktree add ${path} ${vars.head_branch} && cd ${path}`,
        release: `git worktree remove ${path}`,
      };
  }
}
```

### Phase 3 — CI failure context (optional, lower priority)

For `on_ci_failure_branch`, the subagent currently operates in whatever
directory Claude Code is in. With worktrees, the correct behavior is to fix
the code in the branch's worktree:

- `mode=native`: subagent should find the worktree for `{branch}` and work there
- `mode=custom`: subagent uses `create_cmd` to get a worktree

This only matters if the user's main Claude Code session is not checked out
on the failing branch. For now, the user's manually-overrideable
`on_ci_failure_branch.instruction` is sufficient.

---

## What does NOT need to change

- `on_pr_review` — plan mode + skill invocation is directory-agnostic. The
  `Code comments: apply the fix in a worktree` line in the default instruction
  already delegates the how to Claude's judgment. This is fine.
- `on_ci_failure_main` — CI failures on main are fixed by pushing a new commit,
  not a rebase. The subagent works in whatever checkout it has access to.
  Worktree mode doesn't change the workflow.
- `set_filter` — does not need to be extended. The worktree config is
  repo/instance-level, not per-session.

---

## Impact on `config.example.yaml`

A new section with commented examples:

```yaml
# ── Worktree behaviour ─────────────────────────────────────────────────────────
# Controls how the agent obtains a working directory when acting on a PR branch.
# The default creates a temporary worktree and removes it when done.
# Users who work natively in worktrees should set mode: native or mode: custom.
behavior:
  worktrees:
    mode: temp   # temp | native | custom

    # mode=custom: command to create/enter a worktree.
    # Placeholders: {pr_number}, {head_branch}, {base_branch}, {repo}
    # create_cmd: "gt sling {pr_number} myrig"
    create_cmd: ""

    # mode=custom: command to remove the worktree when done. Empty = skip.
    # cleanup_cmd: "gt worktree remove {pr_number}"
    cleanup_cmd: ""
```

---

## Summary

| | Phase 1 (smart default) | Phase 2 (config) |
|---|---|---|
| Zero-config? | ✅ yes | ❌ needs YAML |
| Native worktrees | ✅ auto-detected | ✅ explicit `mode: native` |
| Custom spawn scripts | ❌ not supported | ✅ `mode: custom` + `create_cmd` |
| Effort | Low — rewrite 2 default instructions | Medium — new config type + interpolation helper |
| Risk | Low — instruction text only | Low — additive config, defaults unchanged |

**Recommended sequence:** ship Phase 1 as a quick improvement in the next PR,
then Phase 2 as a follow-up when users ask for custom spawn support.
