/**
 * Relay process — one per Claude Code session, started by Claude Code as an
 * MCP subprocess.
 *
 * Responsibilities:
 *   1. Auto-detect the git repo and branch for the current working directory
 *   2. Connect to the hub over a Unix domain socket and register filters
 *   3. Forward matching notifications from the hub into the Claude Code session
 *      via the MCP channels API
 *   4. Poll for branch changes every 30 s and send heartbeats to the hub
 *
 * Usage in .mcp.json:
 *   "command": "bun"
 *   "args": ["run", "/path/to/src/relay.ts"]
 *   "env": { "GITHUB_TOKEN": "...", "GHCI_HUB_SOCKET": "/tmp/ghci-hub.sock" }
 *
 * The socket path defaults to /tmp/ghci-hub.sock and can be overridden with
 * the GHCI_HUB_SOCKET env var.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_HUB_SOCKET, type HubMessage, type RelayMessage } from "./hub-protocol.js";
import { createMcpServer, sendChannelNotification } from "./server.js";

const log = (...args: unknown[]) => console.error("[github-ci:relay]", ...args);

const RELAY_ID = randomUUID().slice(0, 8);
const BRANCH_POLL_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// ── Git detection ─────────────────────────────────────────────────────────────

/**
 * Run a git command with explicit argv (no shell involved — no injection risk).
 * Returns stdout on success, empty string on any failure.
 */
function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 || result.error) return "";
  return (result.stdout ?? "").trim();
}

/**
 * Derive "owner/repo" from the origin remote URL.
 * Handles SSH (git@github.com:owner/repo.git) and HTTPS formats.
 */
function detectRepo(cwd: string): string | null {
  const url = runGit(["remote", "get-url", "origin"], cwd);
  if (!url) return null;

  const match =
    url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/) ??
    url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? (match[1] ?? null) : null;
}

/** Return the current checked-out branch name, or null on detached HEAD. */
function detectBranch(cwd: string): string | null {
  const branch = runGit(["branch", "--show-current"], cwd);
  return branch || null;
}

// ── MCP setup ─────────────────────────────────────────────────────────────────

const mcp = createMcpServer();

// ── Hub connection ────────────────────────────────────────────────────────────

const socketPath = process.env.GHCI_HUB_SOCKET ?? DEFAULT_HUB_SOCKET;
const cwd = process.cwd();

let currentBranch: string | null = detectBranch(cwd);
const repo = detectRepo(cwd);

log(`Relay ${RELAY_ID} | repo=${repo ?? "unknown"} branch=${currentBranch ?? "unknown"}`);

let hubSocket: net.Socket | null = null;
let lineBuf = "";
let reconnectDelay = RECONNECT_DELAY_MS;

function sendToHub(msg: RelayMessage): void {
  if (!hubSocket || hubSocket.destroyed) return;
  try {
    hubSocket.write(JSON.stringify(msg) + "\n");
  } catch {
    // will reconnect on close
  }
}

function handleHubMessage(raw: string): void {
  let msg: HubMessage;
  try {
    msg = JSON.parse(raw) as HubMessage;
  } catch {
    return;
  }

  if (msg.type === "registered") {
    log(`Registered with hub as relay ${msg.relay_id}`);
    return;
  }

  if (msg.type === "ping") {
    // Respond with current branch so hub keeps filter up to date
    sendToHub({ type: "heartbeat", branch: currentBranch });
    return;
  }

  if (msg.type === "notify") {
    const { notification } = msg;
    log(
      `Forwarding notification to Claude: ${notification.meta.event ?? "event"} on ${notification.meta.repo}`,
    );
    sendChannelNotification(mcp, notification).catch((err) => {
      log("Failed to forward notification:", err);
    });
    return;
  }
}

function connectToHub(): void {
  const socket = net.createConnection(socketPath);
  hubSocket = socket;
  lineBuf = "";

  socket.setEncoding("utf8");

  socket.on("connect", () => {
    reconnectDelay = RECONNECT_DELAY_MS; // reset exponential backoff
    log(`Connected to hub at ${socketPath}`);

    sendToHub({
      type: "register",
      relay_id: RELAY_ID,
      repo,
      branch: currentBranch,
    });
  });

  socket.on("data", (chunk: string) => {
    lineBuf += chunk;
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) handleHubMessage(trimmed);
    }
  });

  socket.on("close", () => {
    hubSocket = null;
    log(`Disconnected from hub — reconnecting in ${reconnectDelay / 1000}s`);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      connectToHub();
    }, reconnectDelay);
  });

  socket.on("error", (err) => {
    // Error fires before close; log and let the close handler reconnect
    log(`Hub socket error: ${err.message}`);
  });
}

// ── Branch polling ────────────────────────────────────────────────────────────

setInterval(() => {
  const branch = detectBranch(cwd);
  if (branch !== currentBranch) {
    log(`Branch changed: ${currentBranch ?? "?"} → ${branch ?? "?"}`);
    currentBranch = branch;
    sendToHub({ type: "heartbeat", branch });
  }
}, BRANCH_POLL_INTERVAL_MS);

// ── Startup ───────────────────────────────────────────────────────────────────

connectToHub();

const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP channel connected to Claude Code");
