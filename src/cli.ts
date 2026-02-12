#!/usr/bin/env node
/**
 * CLI for mcp-simple-memory
 *
 * Usage:
 *   npx mcp-simple-memory init   — Add to .mcp.json
 *   npx mcp-simple-memory serve  — Start MCP server (used by Claude Code)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const args = process.argv.slice(2);
const command = args[0] || "serve";

if (command === "init") {
  init();
} else if (command === "serve") {
  // Import and run the server
  await import("./index.js");
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
mcp-simple-memory — Persistent memory for Claude Code

Commands:
  init    Add mcp-simple-memory to .mcp.json in current directory
  serve   Start the MCP server (default, used by Claude Code)
  help    Show this help

Environment variables:
  GEMINI_API_KEY     Enable semantic search (optional, free tier works)
  MCP_MEMORY_DIR     Custom data directory (default: ~/.mcp-simple-memory)
`);
} else {
  console.error(`Unknown command: ${command}. Run 'mcp-simple-memory help' for usage.`);
  process.exit(1);
}

function init() {
  const mcpPath = join(process.cwd(), ".mcp.json");
  let config: any = {};

  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf-8"));
    } catch {
      console.error("Error: existing .mcp.json is not valid JSON");
      process.exit(1);
    }
  }

  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers["mcp-simple-memory"]) {
    console.log("mcp-simple-memory is already configured in .mcp.json");
    return;
  }

  config.mcpServers["mcp-simple-memory"] = {
    command: "npx",
    args: ["-y", "mcp-simple-memory", "serve"],
    env: {},
  };

  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Added mcp-simple-memory to ${mcpPath}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code to load the new MCP server");
  console.log("  2. (Optional) Add GEMINI_API_KEY to .mcp.json env for semantic search");
  console.log("");
  console.log("Example with semantic search:");
  console.log('  "env": { "GEMINI_API_KEY": "your-key-here" }');
}
