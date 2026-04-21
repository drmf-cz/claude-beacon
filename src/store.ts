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

/** Open (or create) the SQLite database at dbPath. Idempotent — safe to call once at startup. */
export function openFilterStore(dbPath: string): void {
  try {
    db = new Database(dbPath, { create: true });
    db.run(`
      CREATE TABLE IF NOT EXISTS session_filters (
        github_username TEXT PRIMARY KEY NOT NULL,
        repo            TEXT,
        branch          TEXT,
        label           TEXT,
        worktree_path   TEXT,
        updated_at      INTEGER NOT NULL
      )
    `);
    log(`Opened at ${dbPath}`);
  } catch (err) {
    log(`Failed to open — filter persistence disabled: ${err}`);
    db = null;
  }
}

/** Persist the filter for a user. Upserts. No-op if the store is not open. */
export function saveFilter(github_username: string, filter: PersistedFilter): void {
  if (!db) return;
  try {
    db.run(
      `INSERT OR REPLACE INTO session_filters
         (github_username, repo, branch, label, worktree_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [github_username, filter.repo, filter.branch, filter.label, filter.worktree_path, Date.now()],
    );
  } catch (err) {
    log(`saveFilter failed for ${github_username}: ${err}`);
  }
}

/** Return the last saved filter for a user, or null if none exists. */
export function loadFilter(github_username: string): PersistedFilter | null {
  if (!db) return null;
  try {
    const row = db
      .query<
        {
          repo: string | null;
          branch: string | null;
          label: string | null;
          worktree_path: string | null;
        },
        [string]
      >("SELECT repo, branch, label, worktree_path FROM session_filters WHERE github_username = ?")
      .get(github_username);
    return row ?? null;
  } catch (err) {
    log(`loadFilter failed for ${github_username}: ${err}`);
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
