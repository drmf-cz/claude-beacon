import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeFilterStore, loadFilter, openFilterStore, saveFilter } from "../store.js";

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
});

describe("saveFilter + loadFilter", () => {
  it("round-trips all fields including nulls", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", {
      repo: "org/repo",
      branch: "main",
      label: "main",
      worktree_path: "/tmp/repo",
    });
    expect(loadFilter("alice")).toEqual({
      repo: "org/repo",
      branch: "main",
      label: "main",
      worktree_path: "/tmp/repo",
    });
  });

  it("round-trips with all null values", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("bob", { repo: null, branch: null, label: null, worktree_path: null });
    expect(loadFilter("bob")).toEqual({
      repo: null,
      branch: null,
      label: null,
      worktree_path: null,
    });
  });

  it("upserts — second save for same user replaces the row", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", { repo: "org/repo", branch: "main", label: null, worktree_path: null });
    saveFilter("alice", {
      repo: "org/repo",
      branch: "feat/x",
      label: "feat/x",
      worktree_path: "/tmp/x",
    });
    expect(loadFilter("alice")).toEqual({
      repo: "org/repo",
      branch: "feat/x",
      label: "feat/x",
      worktree_path: "/tmp/x",
    });
  });

  it("stores independent rows for different users", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", { repo: "org/a", branch: "main", label: null, worktree_path: null });
    saveFilter("bob", { repo: "org/b", branch: "dev", label: null, worktree_path: null });
    expect(loadFilter("alice")?.repo).toBe("org/a");
    expect(loadFilter("bob")?.repo).toBe("org/b");
  });
});

describe("loadFilter", () => {
  it("returns null for an unknown username", () => {
    openFilterStore(join(testDir, "filters.db"));
    expect(loadFilter("nobody")).toBeNull();
  });

  it("returns null when the store was never opened", () => {
    // store is closed by beforeEach — no openFilterStore call here
    expect(loadFilter("alice")).toBeNull();
  });
});

describe("saveFilter", () => {
  it("is a no-op (no throw) when the store is not open", () => {
    expect(() =>
      saveFilter("alice", { repo: "org/repo", branch: "main", label: null, worktree_path: null }),
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

  it("makes saveFilter and loadFilter no-ops after close", () => {
    openFilterStore(join(testDir, "filters.db"));
    saveFilter("alice", { repo: "org/repo", branch: "main", label: null, worktree_path: null });
    closeFilterStore();
    // These should not throw
    expect(() =>
      saveFilter("alice", { repo: "other", branch: "other", label: null, worktree_path: null }),
    ).not.toThrow();
    expect(loadFilter("alice")).toBeNull();
  });
});
