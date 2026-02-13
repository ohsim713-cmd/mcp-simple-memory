#!/usr/bin/env node
/**
 * CLI for mcp-simple-memory
 *
 * Usage:
 *   npx mcp-simple-memory init              — Add to .mcp.json
 *   npx mcp-simple-memory serve             — Start MCP server (used by Claude Code)
 *   npx mcp-simple-memory import <file>     — Import .md file as memories
 *   npx mcp-simple-memory import <dir>      — Import all .md files in directory
 *   npx mcp-simple-memory stats             — Show memory database stats
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, basename, extname, resolve } from "path";
import { homedir } from "os";
import initSqlJs, { type Database } from "sql.js";

// Config - must be before command dispatch
const DATA_DIR = process.env.MCP_MEMORY_DIR || join(homedir(), ".mcp-simple-memory");
const DB_PATH = join(DATA_DIR, "memory.db");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-embedding-001";

const args = process.argv.slice(2);
const command = args[0] || "serve";

if (command === "init") {
  init();
} else if (command === "serve") {
  await import("./index.js");
} else if (command === "import") {
  await importMemories(args[1], args.slice(2));
} else if (command === "stats") {
  await showStats();
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
mcp-simple-memory — Persistent memory for Claude Code

Commands:
  init                    Add mcp-simple-memory to .mcp.json in current directory
  serve                   Start the MCP server (default, used by Claude Code)
  import <file|dir>       Import .md files as memories
  stats                   Show database statistics
  help                    Show this help

Import options:
  --project <name>        Set project name (default: filename without extension)
  --tags <t1,t2>          Add tags to all imported memories
  --dry-run               Show what would be imported without saving

Environment variables:
  GEMINI_API_KEY     Enable semantic search (optional, free tier works)
  MCP_MEMORY_DIR     Custom data directory (default: ~/.mcp-simple-memory)
`);
} else {
  console.error(`Unknown command: ${command}. Run 'mcp-simple-memory help' for usage.`);
  process.exit(1);
}

// ---- Database helpers (shared with index.ts) --------------------------------

async function openDb(): Promise<Database> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs();
  let db: Database;
  if (existsSync(DB_PATH)) {
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, content TEXT NOT NULL,
    type TEXT DEFAULT 'memory', project TEXT DEFAULT 'default',
    created_at INTEGER NOT NULL, created_iso TEXT NOT NULL,
    updated_at INTEGER, updated_iso TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS embeddings (
    memory_id INTEGER PRIMARY KEY, vector BLOB NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tags (
    memory_id INTEGER NOT NULL, tag TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
  )`);
  return db;
}

function persistDb(db: Database) {
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function queryAll(db: Database, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function getEmbedding(text: string): Promise<Float32Array | null> {
  if (!GEMINI_API_KEY) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${GEMINI_MODEL}`,
          content: { parts: [{ text }] },
        }),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding: { values: number[] } };
    return new Float32Array(data.embedding.values);
  } catch {
    return null;
  }
}

// ---- Markdown chunking ------------------------------------------------------

interface Chunk {
  title: string;
  content: string;
  level: number;
}

function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let currentTitle = "";
  let currentContent: string[] = [];
  let currentLevel = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      // Save previous chunk
      if (currentContent.length > 0 || currentTitle) {
        const content = currentContent.join("\n").trim();
        if (content.length > 10) {
          chunks.push({ title: currentTitle, content, level: currentLevel });
        }
      }
      currentTitle = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Last chunk
  const content = currentContent.join("\n").trim();
  if (content.length > 10) {
    chunks.push({ title: currentTitle, content, level: currentLevel });
  }

  return chunks;
}

// ---- Commands ---------------------------------------------------------------

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

async function importMemories(target: string | undefined, flags: string[]) {
  if (!target) {
    console.error("Usage: mcp-simple-memory import <file.md|directory> [--project name] [--tags t1,t2] [--dry-run]");
    process.exit(1);
  }

  // Parse flags
  let project: string | undefined;
  let extraTags: string[] = [];
  let dryRun = false;

  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--project" && flags[i + 1]) {
      project = flags[++i];
    } else if (flags[i] === "--tags" && flags[i + 1]) {
      extraTags = flags[++i].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    } else if (flags[i] === "--dry-run") {
      dryRun = true;
    }
  }

  const resolvedTarget = resolve(target);

  // Collect files
  let files: string[] = [];
  if (!existsSync(resolvedTarget)) {
    console.error(`Not found: ${resolvedTarget}`);
    process.exit(1);
  }

  if (statSync(resolvedTarget).isDirectory()) {
    files = readdirSync(resolvedTarget)
      .filter((f) => extname(f).toLowerCase() === ".md")
      .map((f) => join(resolvedTarget, f))
      .sort();
  } else {
    files = [resolvedTarget];
  }

  if (!files.length) {
    console.error("No .md files found.");
    process.exit(1);
  }

  console.log(`Found ${files.length} file(s) to import.\n`);

  const db = await openDb();
  let totalChunks = 0;
  let totalEmbedded = 0;

  for (const file of files) {
    const name = basename(file, ".md");
    const proj = project || name;
    const raw = readFileSync(file, "utf-8");
    const chunks = chunkMarkdown(raw);

    console.log(`${name}.md → ${chunks.length} chunks (project: ${proj})`);

    for (const chunk of chunks) {
      const tags = [...extraTags];
      // Auto-tag from heading level
      if (chunk.level === 1) tags.push("section");
      if (chunk.level === 2) tags.push("subsection");

      if (dryRun) {
        const preview = chunk.content.substring(0, 60).replace(/\n/g, " ");
        console.log(`  [dry-run] "${chunk.title}" (${chunk.content.length} chars) ${preview}...`);
        totalChunks++;
        continue;
      }

      const now = Date.now();
      db.run(
        `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
        [chunk.title || name, chunk.content, "memory", proj, now, new Date(now).toISOString()]
      );
      const id = queryAll(db, `SELECT last_insert_rowid() as id`)[0]?.id ?? 0;

      // Tags
      for (const tag of tags) {
        if (tag) db.run(`INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)`, [id, tag.toLowerCase()]);
      }

      // Embedding
      if (GEMINI_API_KEY) {
        const vec = await getEmbedding(`${chunk.title}\n${chunk.content}`);
        if (vec) {
          db.run(`INSERT OR REPLACE INTO embeddings (memory_id, vector) VALUES (?, ?)`, [
            id,
            new Uint8Array(vec.buffer),
          ]);
          totalEmbedded++;
        }
        // Rate limit
        await new Promise((r) => setTimeout(r, 100));
      }

      const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
      console.log(`  #${id} "${chunk.title}" (${chunk.content.length} chars)${tagStr}`);
      totalChunks++;
    }
  }

  if (!dryRun) {
    persistDb(db);
  }
  db.close();

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Imported ${totalChunks} memories from ${files.length} file(s).`);
  if (totalEmbedded > 0) {
    console.log(`Generated ${totalEmbedded} embeddings.`);
  } else if (!GEMINI_API_KEY && !dryRun) {
    console.log("Tip: Set GEMINI_API_KEY to auto-generate embeddings during import.");
  }
}

async function showStats() {
  if (!existsSync(DB_PATH)) {
    console.log("No database found. Run 'mcp-simple-memory init' first.");
    return;
  }

  const db = await openDb();

  const memCount = queryAll(db, `SELECT COUNT(*) as c FROM memories`)[0]?.c ?? 0;
  const embCount = queryAll(db, `SELECT COUNT(*) as c FROM embeddings`)[0]?.c ?? 0;
  const tagCount = queryAll(db, `SELECT COUNT(DISTINCT tag) as c FROM tags`)[0]?.c ?? 0;

  const projects = queryAll(db, `SELECT project, COUNT(*) as c FROM memories GROUP BY project ORDER BY c DESC`);
  const types = queryAll(db, `SELECT type, COUNT(*) as c FROM memories GROUP BY type ORDER BY c DESC`);
  const topTags = queryAll(db, `SELECT tag, COUNT(*) as c FROM tags GROUP BY tag ORDER BY c DESC LIMIT 10`);

  console.log(`mcp-simple-memory stats`);
  console.log(`  DB: ${DB_PATH}\n`);
  console.log(`  Memories:   ${memCount}`);
  console.log(`  Embeddings: ${embCount}/${memCount} (${memCount ? Math.round(embCount / memCount * 100) : 0}%)`);
  console.log(`  Tags:       ${tagCount} unique\n`);

  if (projects.length) {
    console.log(`  Projects:`);
    for (const p of projects) console.log(`    ${p.project}: ${p.c}`);
    console.log("");
  }

  if (types.length) {
    console.log(`  Types:`);
    for (const t of types) console.log(`    ${t.type}: ${t.c}`);
    console.log("");
  }

  if (topTags.length) {
    console.log(`  Top tags:`);
    for (const t of topTags) console.log(`    ${t.tag}: ${t.c}`);
  }

  db.close();
}
