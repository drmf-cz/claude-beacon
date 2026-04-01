/**
 * Poll-mode entrypoint — no webhook server needed, no public URL required.
 * Polls GitHub API every 30s for completed workflow runs on configured repos.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... WATCH_REPOS=owner/repo1,owner/repo2 bun run src/poll.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { startPoller } from "./poller.js";

const log = (...args: unknown[]) => console.error("[github-ci]", ...args);

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("ERROR: GITHUB_TOKEN is required in poll mode");
  process.exit(1);
}

const repos = (process.env.WATCH_REPOS ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

if (repos.length === 0) {
  console.error("ERROR: WATCH_REPOS must be set (e.g. owner/repo1,owner/repo2)");
  process.exit(1);
}

const intervalMs = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10);

const mcp = createMcpServer();

// Connect to Claude Code via stdio first
const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP channel connected to Claude Code");

// Start polling
startPoller(repos, token, mcp, intervalMs);
