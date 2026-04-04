import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { createMcpServer, sendChannelNotification, startWebhookServer } from "./server.js";

const log = (...args: unknown[]) => console.error("[github-ci]", ...args);

// ── CLI argument parsing ──────────────────────────────────────────────────────
// Supports: --config <path>  --author <username|email> (repeatable)
function parseArgs(argv: string[]): { configPath: string | null; authors: string[] } {
  const configIdx = argv.indexOf("--config");
  const configPath = configIdx !== -1 ? (argv[configIdx + 1] ?? null) : null;
  const authors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--author" && argv[i + 1]) {
      authors.push(argv[i + 1] ?? "");
    }
  }
  return { configPath, authors };
}

const rawArgs = process.argv.slice(2);

// ── --help ────────────────────────────────────────────────────────────────────
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  process.stdout.write(`claude-beacon — GitHub CI/PR → Claude Code notifications

Usage:
  claude-beacon --author <username> [options]

Required:
  --author <username|email>   GitHub username or email whose PRs trigger
                              actions. Repeat for multiple entries.
                              Equivalent to webhooks.allowed_authors in YAML.

Options:
  --config <path>             Path to a YAML config file (see config.example.yaml)
  --help, -h                  Show this help message

Environment variables:
  GITHUB_WEBHOOK_SECRET       HMAC-SHA256 secret — must match GitHub webhook settings
  GITHUB_TOKEN                PAT for log fetching and PR status checks
                              Fine-grained: Actions:Read + Pull requests:Read
                              Classic: public_repo
  WEBHOOK_PORT                HTTP port for webhook receiver (default: 9443)
  REVIEW_DEBOUNCE_MS          Review event batching window ms (default: 30000)

Quick start:
  1. Generate a secret:   openssl rand -hex 32
  2. Start a tunnel:      cloudflared tunnel --url http://localhost:9443
  3. Add to ~/.mcp.json:
       {
         "mcpServers": {
           "claude-beacon": {
             "command": "/home/you/.bun/bin/claude-beacon",
             "args": ["--author", "YourGitHubUsername"],
             "env": {
               "GITHUB_WEBHOOK_SECRET": "<secret from step 1>",
               "GITHUB_TOKEN": "<your PAT>"
             }
           }
         }
       }
  4. Register webhook on GitHub (repo Settings → Webhooks)
  5. Start Claude Code:   claude --dangerously-load-development-channels server:claude-beacon

For multi-session (mux) mode, use the claude-beacon-mux binary instead.
Full docs: https://github.com/drmf-cz/claude-beacon\n`);
  process.exit(0);
}

const { configPath, authors } = parseArgs(rawArgs);

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

if (authors.length > 0) {
  config.webhooks.allowed_authors = [...new Set([...config.webhooks.allowed_authors, ...authors])];
}

// ── Startup validation ────────────────────────────────────────────────────────
if (config.webhooks.allowed_authors.length === 0) {
  log(
    "ERROR: webhooks.allowed_authors is required and must not be empty.",
    "\nAdd your GitHub username (and optionally your email for co-author matching via bots like Devin).",
    "\nExample config.yaml:",
    "\n  webhooks:",
    "\n    allowed_authors:",
    "\n      - YourGitHubUsername",
    "\n      - you@company.com  # for Co-Authored-By matching",
    "\nOr pass directly: claude-beacon --author YourGitHubUsername",
  );
  process.exit(1);
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
