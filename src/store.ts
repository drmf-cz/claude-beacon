import { Database } from "bun:sqlite";

const log = (...args: unknown[]) =>
  console.error(`[github-ci:store] ${new Date().toISOString().slice(11, 23)}`, ...args);

export interface PersistedFilter {
  repo: string | null;
  branch: string | null;
  label: string | null;
  worktree_path: string | null;
}

let db: Database | null = null;

const SCHEMA_VERSION = 1;

const FILTER_TABLE_COLUMNS = `(
    github_username TEXT NOT NULL,
    worktree_path   TEXT NOT NULL DEFAULT '',
    repo            TEXT,
    branch          TEXT,
    label           TEXT,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (github_username, worktree_path)
  )`;

/** Open (or create) the SQLite database at dbPath. Idempotent — safe to call once at startup. */
export function openFilterStore(dbPath: string): void {
  try {
    db = new Database(dbPath, { create: true });
    // Schema migration: v0 (single github_username PK) → v1 (composite PK with worktree_path)
    const version =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version < SCHEMA_VERSION) {
      db.run("DROP TABLE IF EXISTS session_filters");
      db.run(`CREATE TABLE session_filters ${FILTER_TABLE_COLUMNS}`);
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else {
      db.run(`CREATE TABLE IF NOT EXISTS session_filters ${FILTER_TABLE_COLUMNS}`);
    }
    // pending_queue and session_behaviors are additive — safe to create without bumping schema version
    db.run(`CREATE TABLE IF NOT EXISTS pending_queue (
      id           TEXT PRIMARY KEY,
      repo         TEXT NOT NULL,
      branch       TEXT,
      pr_author    TEXT,
      notification TEXT NOT NULL,
      routing      TEXT NOT NULL,
      received_at  INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS session_behaviors (
      github_username TEXT PRIMARY KEY NOT NULL,
      behavior_yaml   TEXT NOT NULL,
      updated_at      INTEGER NOT NULL
    )`);
    log(`Opened at ${dbPath}`);
  } catch (err) {
    log(`Failed to open — filter persistence disabled: ${err}`);
    db = null;
  }
}

// ── Pending queue persistence ─────────────────────────────────────────────────

export interface PersistedPendingEntry {
  id: string;
  routing: { repo: string; branch: string | null; pr_author?: string | null };
  notification: Record<string, unknown>;
  receivedAt: number;
}

/** Persist a pending notification to SQLite. No-op if the store is not open. */
export function savePending(
  id: string,
  routing: PersistedPendingEntry["routing"],
  notification: Record<string, unknown>,
): void {
  if (!db) return;
  try {
    db.run(
      `INSERT OR REPLACE INTO pending_queue (id, repo, branch, pr_author, notification, routing, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        routing.repo,
        routing.branch,
        routing.pr_author ?? null,
        JSON.stringify(notification),
        JSON.stringify(routing),
        Date.now(),
      ],
    );
  } catch (err) {
    log(`savePending failed for ${id}: ${err}`);
  }
}

/** Load all persisted pending notifications, oldest first. */
export function loadAllPending(): PersistedPendingEntry[] {
  if (!db) return [];
  try {
    const rows = db
      .query<{ id: string; routing: string; notification: string; received_at: number }, []>(
        "SELECT id, routing, notification, received_at FROM pending_queue ORDER BY received_at ASC",
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      routing: JSON.parse(row.routing) as PersistedPendingEntry["routing"],
      notification: JSON.parse(row.notification) as Record<string, unknown>,
      receivedAt: row.received_at,
    }));
  } catch (err) {
    log(`loadAllPending failed: ${err}`);
    return [];
  }
}

/** Delete a single pending notification by id (call after successful delivery). */
export function deletePending(id: string): void {
  if (!db) return;
  try {
    db.run("DELETE FROM pending_queue WHERE id = ?", [id]);
  } catch (err) {
    log(`deletePending failed for ${id}: ${err}`);
  }
}

/** Delete all pending notifications older than maxAgeMs. Returns count deleted. */
export function deleteExpiredPending(maxAgeMs: number): number {
  if (!db) return 0;
  try {
    const result = db.run("DELETE FROM pending_queue WHERE received_at < ?", [
      Date.now() - maxAgeMs,
    ]);
    return result.changes;
  } catch (err) {
    log(`deleteExpiredPending failed: ${err}`);
    return 0;
  }
}

/**
 * Persist the filter for a (username, worktree_path) pair. Upserts.
 * worktree_path=null is stored as "" so it can participate in the composite PK.
 * No-op if the store is not open.
 */
export function saveFilter(
  github_username: string,
  worktree_path: string | null,
  filter: PersistedFilter,
): void {
  if (!db) return;
  const wt = worktree_path ?? "";
  try {
    db.run(
      `INSERT OR REPLACE INTO session_filters
         (github_username, worktree_path, repo, branch, label, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [github_username, wt, filter.repo, filter.branch, filter.label, Date.now()],
    );
  } catch (err) {
    log(`saveFilter failed for ${github_username}@${wt}: ${err}`);
  }
}

/**
 * Returns the persisted filter only if this user has exactly ONE row.
 * - 0 rows → null (user never called set_filter, or store was wiped)
 * - 1 row → return it (single-session user; safe to restore unambiguously)
 * - 2+ rows → null (multi-session user; ambiguous which filter belongs to this reconnecting
 *   session — fall back to default_filter or null/null)
 *
 * The "" worktree_path sentinel is converted back to null in the returned struct.
 */
export function loadUniqueFilter(github_username: string): PersistedFilter | null {
  if (!db) return null;
  try {
    const rows = db
      .query<
        {
          repo: string | null;
          branch: string | null;
          label: string | null;
          worktree_path: string;
        },
        [string]
      >("SELECT repo, branch, label, worktree_path FROM session_filters WHERE github_username = ?")
      .all(github_username);
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (!row) return null;
    return {
      repo: row.repo,
      branch: row.branch,
      label: row.label,
      worktree_path: row.worktree_path === "" ? null : row.worktree_path,
    };
  } catch (err) {
    log(`loadUniqueFilter failed for ${github_username}: ${err}`);
    return null;
  }
}

// ── Behavior persistence ──────────────────────────────────────────────────────

/** Persist the raw behavior YAML for a user. Upserts. No-op if the store is not open. */
export function saveUserBehavior(github_username: string, behavior_yaml: string): void {
  if (!db) return;
  try {
    db.run(
      `INSERT OR REPLACE INTO session_behaviors (github_username, behavior_yaml, updated_at)
       VALUES (?, ?, ?)`,
      [github_username, behavior_yaml, Date.now()],
    );
  } catch (err) {
    log(`saveUserBehavior failed for ${github_username}: ${err}`);
  }
}

/** Return the last saved behavior YAML for a user, or null if none exists. */
export function loadUserBehavior(github_username: string): string | null {
  if (!db) return null;
  try {
    const row = db
      .query<{ behavior_yaml: string }, [string]>(
        "SELECT behavior_yaml FROM session_behaviors WHERE github_username = ?",
      )
      .get(github_username);
    return row?.behavior_yaml ?? null;
  } catch (err) {
    log(`loadUserBehavior failed for ${github_username}: ${err}`);
    return null;
  }
}

/** Close the database. Used for clean shutdown and test isolation. */
export function closeFilterStore(): void {
  try {
    db?.close();
  } catch {
    // Best-effort
  }
  db = null;
}
