/**
 * Hub process — runs once per machine, shared by all Claude Code sessions.
 *
 * Responsibilities:
 *   1. Receive GitHub webhook events over HTTP (:9443 by default)
 *   2. Parse / debounce events using the same logic as the standalone server
 *   3. Route resulting notifications to the correct relay process(es) over a
 *      Unix domain socket (/tmp/ghci-hub.sock by default)
 *
 * Start with:
 *   bun run src/hub.ts [--config path/to/config.yaml]
 *
 * The socket path can be overridden with the GHCI_HUB_SOCKET env var.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import {
  DEFAULT_HUB_SOCKET,
  type HubMessage,
  type NotifyFn,
  type RelayMessage,
  type RoutingKey,
} from "./hub-protocol.js";
import { startWebhookServer } from "./server.js";
import type { CINotification } from "./types.js";

const log = (...args: unknown[]) => console.error("[github-ci:hub]", ...args);

// ── Relay registry ────────────────────────────────────────────────────────────

interface RelayEntry {
  id: string;
  socket: net.Socket;
  repo: string | null;
  branch: string | null;
  lastSeen: number;
  /** Accumulated partial line data between TCP segments. */
  lineBuf: string;
}

const relays = new Map<string, RelayEntry>();

function send(relay: RelayEntry, msg: HubMessage): void {
  try {
    relay.socket.write(JSON.stringify(msg) + "\n");
  } catch {
    // Socket may be closed; cleanup happens in the "close" handler
  }
}

// ── Routing ───────────────────────────────────────────────────────────────────

function matchesRelay(relay: RelayEntry, routing: RoutingKey): boolean {
  // Wildcard relay receives everything
  if (relay.repo === null) return true;
  // Repo must match
  if (relay.repo !== routing.repo) return false;
  // Broadcast routing (no specific branch required)
  if (routing.branch === null) return true;
  // Relay with no branch filter receives all events for its repo
  if (relay.branch === null) return true;
  // Both sides have a branch — must match exactly
  return relay.branch === routing.branch;
}

/** Forward a notification to every relay whose filters match the routing key. */
const routeNotification: NotifyFn = async (
  notification: CINotification,
  routing: RoutingKey,
): Promise<void> => {
  let sent = 0;
  for (const relay of relays.values()) {
    if (matchesRelay(relay, routing)) {
      send(relay, { type: "notify", notification, routing });
      sent++;
    }
  }
  if (sent === 0) {
    log(`No relay matched ${routing.repo}@${routing.branch ?? "*"} — notification dropped`);
  } else {
    log(`Routed to ${sent} relay(s): ${routing.repo}@${routing.branch ?? "*"}`);
  }
};

// ── Relay message handling ────────────────────────────────────────────────────

function handleRelayMessage(relay: RelayEntry, raw: string): void {
  let msg: RelayMessage;
  try {
    msg = JSON.parse(raw) as RelayMessage;
  } catch {
    log(`Invalid JSON from relay ${relay.id}: ${raw.slice(0, 80)}`);
    return;
  }

  relay.lastSeen = Date.now();

  if (msg.type === "register") {
    relay.repo = msg.repo;
    relay.branch = msg.branch;
    log(`Relay ${relay.id} registered: repo=${msg.repo ?? "*"} branch=${msg.branch ?? "*"}`);
    send(relay, { type: "registered", relay_id: relay.id });
    return;
  }

  if (msg.type === "heartbeat") {
    if (relay.branch !== msg.branch) {
      log(`Relay ${relay.id} branch update: ${relay.branch ?? "*"} → ${msg.branch ?? "*"}`);
      relay.branch = msg.branch;
    }
    return;
  }
}

// ── Unix socket server ────────────────────────────────────────────────────────

function startRelayServer(socketPath: string): net.Server {
  // Clean up stale socket file from a previous crashed run
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore — may already be gone
    }
  }

  const server = net.createServer((socket) => {
    const relay: RelayEntry = {
      id: randomUUID().slice(0, 8),
      socket,
      repo: null,
      branch: null,
      lastSeen: Date.now(),
      lineBuf: "",
    };
    relays.set(relay.id, relay);
    log(`Relay connected: ${relay.id} (total: ${relays.size})`);

    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => {
      relay.lineBuf += chunk;
      const lines = relay.lineBuf.split("\n");
      relay.lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handleRelayMessage(relay, trimmed);
      }
    });

    socket.on("close", () => {
      relays.delete(relay.id);
      log(`Relay disconnected: ${relay.id} (total: ${relays.size})`);
    });

    socket.on("error", (err) => {
      log(`Relay ${relay.id} socket error:`, err.message);
      relays.delete(relay.id);
    });
  });

  server.listen(socketPath, () => {
    log(`Relay socket listening at ${socketPath}`);
  });

  server.on("error", (err) => {
    log("Relay server error:", err);
  });

  return server;
}

// ── Keepalive pings ───────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 30_000;
const RELAY_TIMEOUT_MS = 90_000;

setInterval(() => {
  const now = Date.now();
  for (const relay of relays.values()) {
    if (now - relay.lastSeen > RELAY_TIMEOUT_MS) {
      log(`Relay ${relay.id} timed out — dropping`);
      relay.socket.destroy();
      relays.delete(relay.id);
      continue;
    }
    send(relay, { type: "ping" });
  }
}, PING_INTERVAL_MS);

// ── Startup ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { configPath: string | null } {
  const configIdx = argv.indexOf("--config");
  const configPath = configIdx !== -1 ? (argv[configIdx + 1] ?? null) : null;
  return { configPath };
}

const { configPath } = parseArgs(process.argv.slice(2));

let config = DEFAULT_CONFIG;
if (configPath) {
  try {
    config = loadConfig(configPath);
    log(`Loaded config from ${configPath}`);
  } catch (err) {
    log(`ERROR: Failed to load config: ${err}`);
    process.exit(1);
  }
}

const socketPath = process.env.GHCI_HUB_SOCKET ?? DEFAULT_HUB_SOCKET;
startRelayServer(socketPath);

try {
  const webhookServer = startWebhookServer(routeNotification, config);
  log(`Webhook server listening on http://localhost:${webhookServer.port}`);
} catch (err: unknown) {
  const isAddrInUse =
    typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
  if (isAddrInUse) {
    log(`ERROR: Port ${config.server.port} is already in use. Only one hub may run at a time.`);
  } else {
    log("ERROR: Failed to start webhook server:", err);
  }
  process.exit(1);
}

// Graceful shutdown: remove socket file so the next start is clean
process.on("SIGTERM", () => {
  log("SIGTERM received — shutting down");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  process.exit(0);
});
process.on("SIGINT", () => {
  log("SIGINT received — shutting down");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  process.exit(0);
});

log("Hub ready. Waiting for relays and webhook events.");
