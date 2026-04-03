import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { createMcpServer, sendChannelNotification, startWebhookServer } from "./server.js";

const log = (...args: unknown[]) => console.error("[github-ci]", ...args);

// ── CLI argument parsing ──────────────────────────────────────────────────────
// Supports: --config <path>
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

// ── Server startup ────────────────────────────────────────────────────────────
const mcp = createMcpServer();

try {
  const webhookServer = startWebhookServer(
    async (notification) => sendChannelNotification(mcp, notification),
    config,
  );
  log(`Webhook server listening on http://localhost:${webhookServer.port}`);
} catch (err: unknown) {
  const isAddrInUse =
    typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
  if (isAddrInUse) {
    log(
      `ERROR: Port ${config.server.port} is already in use.`,
      "Kill the existing process (lsof -i :9443) and restart Claude Code.",
    );
  } else {
    log("ERROR: Failed to start webhook server:", err);
  }
  process.exit(1);
}

const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP channel connected to Claude Code");
