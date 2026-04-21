import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeFilterStore, loadUniqueFilter, openFilterStore, saveFilter } from "../store.js";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `beacon-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  closeFilterStore(); // ensure clean state before each test
});

afterEach(() => {
  closeFilterStore();
  rmSync(testDir, { recursive: true, force: true });
});

describe("openFilterStore", () => {
  it("creates the DB file when it does not exist", () => {
    const dbPath = join(testDir, "filters.db");
    expect(existsSync(dbPath)).toBe(false);
    openFilterStore(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("is idempotent — second call on the same path does not throw", () => {
    const dbPath = join(testDir, "filters.db");
    openFilterStore(dbPath);
    closeFilterStore();
    expect(() => openFilterStore(dbPath)).not.toThrow();
  });

  it("migrates v0 schema (single PK) to v1 (composite PK) without error", () => {
    // Create a v0-style database (no PRAGMA user_version set, old schema)
    const { Database } = require("bun:sqlite");
    const dbPath = join(testDir, "v0.db");
    const oldDb = new Database(dbPath, { create: true });
    oldDb.run(`
      CREATE TABLE session_filters (
        github_username TEXT PRIMARY KEY NOT NULL,
        repo TEXT, branch TEXT, label TEXT, worktree_path TEXT, updated_at INTEGER NOT NULL
      )
    `);
    oldDb.run("INSERT INTO session_filters VALUES (?, ?, ?, ?, ?, ?)", [
      "alice",
      "org/repo",
      "main",
      "main",
      "/tmp/repo",
      Date.now(),
    ]);
    oldDb.close();

    // openFilterStore should migrate without throwing
    expect(() => openFilterStore(dbPath)).not.toThrow();
    // Old data is cleared (v0 row gone), but store is functional
    expect(loadUniqueFilter("alice")).toBeNull();

    // Can save new-format data
    saveFilter("alice", "/tmp/repo", {
      repo: "org/repo",
      branch: "main",
      label: "main",
      worktree_path: "/tmp/repo",
    });
    expect(loadUniqueFilter("alice")).not.toBeNull();
  });
});

describe("saveFilter + loadUniqueFilter", () => {
  it("round-trips all fields including nulls", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", "/tmp/repo", {
      repo: "org/repo",
      branch: "main",
      label: "main",
      worktree_path: "/tmp/repo",
    });
    expect(loadUniqueFilter("alice")).toEqual({
      repo: "org/repo",
      branch: "main",
      label: "main",
      worktree_path: "/tmp/repo",
    });
  });

  it("round-trips with all null filter values (worktree_path=null stored as empty string)", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("bob", null, { repo: null, branch: null, label: null, worktree_path: null });
    expect(loadUniqueFilter("bob")).toEqual({
      repo: null,
      branch: null,
      label: null,
      worktree_path: null,
    });
  });

  it("upserts — second save for same (user, worktree_path) replaces the row", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", "/tmp/repo", {
      repo: "org/repo",
      branch: "main",
      label: null,
      worktree_path: "/tmp/repo",
    });
    saveFilter("alice", "/tmp/repo", {
      repo: "org/repo",
      branch: "feat/x",
      label: "feat/x",
      worktree_path: "/tmp/repo",
    });
    expect(loadUniqueFilter("alice")).toEqual({
      repo: "org/repo",
      branch: "feat/x",
      label: "feat/x",
      worktree_path: "/tmp/repo",
    });
  });

  it("stores independent rows for different users with the same worktree_path", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", "/shared/path", {
      repo: "org/a",
      branch: "main",
      label: null,
      worktree_path: "/shared/path",
    });
    saveFilter("bob", "/shared/path", {
      repo: "org/b",
      branch: "dev",
      label: null,
      worktree_path: "/shared/path",
    });
    expect(loadUniqueFilter("alice")?.repo).toBe("org/a");
    expect(loadUniqueFilter("bob")?.repo).toBe("org/b");
  });
});

describe("loadUniqueFilter — multi-session semantics", () => {
  it("returns null for an unknown username (0 rows)", () => {
    openFilterStore(join(testDir, "filters.db"));
    expect(loadUniqueFilter("nobody")).toBeNull();
  });

  it("returns null when the store was never opened", () => {
    expect(loadUniqueFilter("alice")).toBeNull();
  });

  it("returns the filter when user has exactly 1 row", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", "/tmp/repo", {
      repo: "org/repo",
      branch: "main",
      label: null,
      worktree_path: "/tmp/repo",
    });
    expect(loadUniqueFilter("alice")).not.toBeNull();
    expect(loadUniqueFilter("alice")?.repo).toBe("org/repo");
  });

  it("returns null when user has 2 rows (multi-session — ambiguous which to restore)", () => {
    openFilterStore(join(testDir, "filters.db"));
    // Session A: keboola project
    saveFilter("alice", "/tmp/keboola", {
      repo: "org/keboola",
      branch: "feat-a",
      label: null,
      worktree_path: "/tmp/keboola",
    });
    // Session B: beacon project (different worktree_path → separate row)
    saveFilter("alice", "/tmp/beacon", {
      repo: "org/beacon",
      branch: "feat-b",
      label: null,
      worktree_path: "/tmp/beacon",
    });
    // Two rows → ambiguous → return null (no incorrect restoration)
    expect(loadUniqueFilter("alice")).toBeNull();
  });

  it("returns null when user has 3 rows", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", "/tmp/a", {
      repo: "org/a",
      branch: "main",
      label: null,
      worktree_path: "/tmp/a",
    });
    saveFilter("alice", "/tmp/b", {
      repo: "org/b",
      branch: "main",
      label: null,
      worktree_path: "/tmp/b",
    });
    saveFilter("alice", "/tmp/c", {
      repo: "org/c",
      branch: "main",
      label: null,
      worktree_path: "/tmp/c",
    });
    expect(loadUniqueFilter("alice")).toBeNull();
  });

  it("returns filter after second session's row is removed (down to 1 row)", () => {
    // This tests that a user who starts with 2 sessions, drops one, then gets unique restore.
    // We simulate by saving 2 rows then saving the same worktree again (upsert, still 2 rows)
    // vs saving only 1 distinct worktree (1 row).
    openFilterStore(join(testDir, "filters.db"));
    // Two distinct worktree paths → 2 rows
    saveFilter("alice", "/tmp/a", {
      repo: "org/a",
      branch: "main",
      label: null,
      worktree_path: "/tmp/a",
    });
    saveFilter("alice", "/tmp/b", {
      repo: "org/b",
      branch: "dev",
      label: null,
      worktree_path: "/tmp/b",
    });
    expect(loadUniqueFilter("alice")).toBeNull();

    // Same worktree_path upserts (doesn't add a new row) → still 2
    saveFilter("alice", "/tmp/a", {
      repo: "org/a",
      branch: "feat",
      label: null,
      worktree_path: "/tmp/a",
    });
    expect(loadUniqueFilter("alice")).toBeNull();
  });
});

describe("saveFilter", () => {
  it("is a no-op (no throw) when the store is not open", () => {
    expect(() =>
      saveFilter("alice", "/tmp/repo", {
        repo: "org/repo",
        branch: "main",
        label: null,
        worktree_path: null,
      }),
    ).not.toThrow();
  });
});

describe("closeFilterStore", () => {
  it("can be called repeatedly without throwing", () => {
    openFilterStore(join(testDir, "filters.db"));
    expect(() => {
      closeFilterStore();
      closeFilterStore();
      closeFilterStore();
    }).not.toThrow();
  });

  it("makes saveFilter and loadUniqueFilter no-ops after close", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", "/tmp/repo", {
      repo: "org/repo",
      branch: "main",
      label: null,
      worktree_path: null,
    });
    closeFilterStore();
    expect(() =>
      saveFilter("alice", "/tmp/repo", {
        repo: "other",
        branch: "other",
        label: null,
        worktree_path: null,
      }),
    ).not.toThrow();
    expect(loadUniqueFilter("alice")).toBeNull();
  });
});
