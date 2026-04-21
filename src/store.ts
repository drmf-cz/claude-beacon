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

const TABLE_COLUMNS = `(
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
      db.run(`CREATE TABLE session_filters ${TABLE_COLUMNS}`);
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else {
      db.run(`CREATE TABLE IF NOT EXISTS session_filters ${TABLE_COLUMNS}`);
    }
    log(`Opened at ${dbPath}`);
  } catch (err) {
    log(`Failed to open — filter persistence disabled: ${err}`);
    db = null;
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

/** Close the database. Used for clean shutdown and test isolation. */
export function closeFilterStore(): void {
  try {
    db?.close();
  } catch {
    // Best-effort
  }
  db = null;
}
