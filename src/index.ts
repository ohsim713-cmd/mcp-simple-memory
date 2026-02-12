#!/usr/bin/env node
/**
 * mcp-simple-memory - Persistent memory for Claude Code
 *
 * SQLite (sql.js WASM, zero native deps).
 * Optional Gemini semantic search. Works on Windows/Mac/Linux.
 *
 * Tools:
 *   mem_save    - Save a memory (with optional tags)
 *   mem_search  - Search (keyword + optional vector)
 *   mem_get     - Fetch by IDs (full content)
 *   mem_list    - Recent memories
 *   mem_update  - Update an existing memory
 *   mem_delete  - Delete memories by IDs
 *   mem_tags    - List all tags (with counts)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import initSqlJs, { type Database } from "sql.js";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

// ---- Config ---------------------------------------------------------------
const DATA_DIR = process.env.MCP_MEMORY_DIR || join(homedir(), ".mcp-simple-memory");
const DB_PATH = join(DATA_DIR, "memory.db");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMS = 3072;

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ---- Database -------------------------------------------------------------
let db: Database;

async function initDb() {
  const SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'memory',
      project TEXT DEFAULT 'default',
      created_at INTEGER NOT NULL,
      created_iso TEXT NOT NULL,
      updated_at INTEGER,
      updated_iso TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      memory_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);`);

  // Migration: add updated_at/updated_iso columns if missing
  try {
    db.run(`SELECT updated_at FROM memories LIMIT 1`);
  } catch {
    try { db.run(`ALTER TABLE memories ADD COLUMN updated_at INTEGER`); } catch { /* already exists */ }
    try { db.run(`ALTER TABLE memories ADD COLUMN updated_iso TEXT`); } catch { /* already exists */ }
  }

  // Migration: create tags table if missing (for upgrades from 0.1.x)
  // Already handled by CREATE TABLE IF NOT EXISTS above

  persist();
}

function persist() {
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// ---- Query helper ---------------------------------------------------------
function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function runSql(sql: string, params: any[] = []) {
  db.run(sql, params);
}

function getByIds(ids: number[]): any[] {
  if (!ids.length) return [];
  const rows = queryAll(
    `SELECT * FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
  // Attach tags to each row
  for (const row of rows) {
    row.tags = getTagsForMemory(row.id);
  }
  return rows;
}

function getTagsForMemory(memoryId: number): string[] {
  return queryAll(`SELECT tag FROM tags WHERE memory_id = ?`, [memoryId]).map(
    (r) => r.tag
  );
}

function setTagsForMemory(memoryId: number, tags: string[]) {
  runSql(`DELETE FROM tags WHERE memory_id = ?`, [memoryId]);
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized) {
      runSql(`INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)`, [
        memoryId,
        normalized,
      ]);
    }
  }
}

// ---- Gemini Embeddings ----------------------------------------------------
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

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    nA = 0,
    nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const denom = Math.sqrt(nA) * Math.sqrt(nB);
  return denom === 0 ? 0 : dot / denom;
}

async function vectorSearch(query: string, limit: number, project?: string) {
  const qVec = await getEmbedding(query);
  if (!qVec) return [];

  const sql = project
    ? `SELECT e.memory_id, e.vector FROM embeddings e JOIN memories m ON m.id = e.memory_id WHERE m.project = ?`
    : `SELECT memory_id, vector FROM embeddings`;
  const rows = queryAll(sql, project ? [project] : []);

  const scored = rows.map((r) => {
    const buf =
      r.vector instanceof Uint8Array ? r.vector : new Uint8Array(r.vector);
    const vec = new Float32Array(buf.buffer, buf.byteOffset, EMBEDDING_DIMS);
    return { id: r.memory_id, score: cosine(qVec, vec) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---- Response helpers -----------------------------------------------------
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
function formatRows(rows: any[], header: string) {
  if (!rows.length) return ok(`${header}\n\n(no results)`);
  const lines = rows.map((r) => {
    const preview = (r.content || "").substring(0, 150).replace(/\n/g, " ");
    const tags = r.tags?.length ? ` [${r.tags.join(", ")}]` : "";
    const updated = r.updated_iso ? ` (updated: ${r.updated_iso})` : "";
    return `#${r.id} | ${r.type} | ${r.project} | ${r.created_iso}${updated}\n  ${r.title || "(no title)"}${tags}\n  ${preview}`;
  });
  return ok(`# ${header} (${rows.length})\n\n${lines.join("\n\n")}`);
}

// ---- Tool Handlers --------------------------------------------------------

async function handleSave(args: Record<string, any>) {
  const content = args.text || args.content;
  if (!content) return err("text is required");

  const now = Date.now();
  const title = args.title || content.substring(0, 80);
  const project = args.project || "default";
  const type = args.type || "memory";

  runSql(
    `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
    [title, content, type, project, now, new Date(now).toISOString()]
  );
  const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id ?? 0;

  // Tags
  const tags: string[] = args.tags || [];
  if (tags.length) {
    setTagsForMemory(id, tags);
  }

  persist();

  // Background embedding (fire-and-forget)
  if (GEMINI_API_KEY) {
    getEmbedding(`${title}\n${content}`).then((vec) => {
      if (vec) {
        runSql(
          `INSERT OR REPLACE INTO embeddings (memory_id, vector) VALUES (?, ?)`,
          [id, vec.buffer]
        );
        persist();
      }
    });
  }

  const tagStr = tags.length ? ` tags: [${tags.join(", ")}]` : "";
  return ok(`Saved memory #${id} (project: ${project})${tagStr}`);
}

async function handleSearch(args: Record<string, any>) {
  const query: string | undefined = args.query;
  const limit: number = args.limit || 20;
  const project: string | undefined = args.project;
  const mode: string = args.mode || "auto";
  const tag: string | undefined = args.tag;
  const type: string | undefined = args.type;

  // Tag-only search
  if (tag && !query) {
    let sql = `SELECT m.* FROM memories m JOIN tags t ON m.id = t.memory_id WHERE t.tag = ?`;
    const params: any[] = [tag.toLowerCase()];
    if (project) {
      sql += ` AND m.project = ?`;
      params.push(project);
    }
    if (type) {
      sql += ` AND m.type = ?`;
      params.push(type);
    }
    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = queryAll(sql, params);
    for (const row of rows) row.tags = getTagsForMemory(row.id);
    return formatRows(rows, `Tag: "${tag}"`);
  }

  // No query -> return recent
  if (!query) {
    let sql = `SELECT * FROM memories`;
    const params: any[] = [];
    const conds: string[] = [];
    if (project) {
      conds.push(`project = ?`);
      params.push(project);
    }
    if (type) {
      conds.push(`type = ?`);
      params.push(type);
    }
    if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = queryAll(sql, params);
    for (const row of rows) row.tags = getTagsForMemory(row.id);
    return formatRows(rows, "Recent memories");
  }

  let kwResults: any[] = [];
  let vecResults: Array<{ id: number; score: number }> = [];

  // Keyword search (LIKE)
  if (mode === "fts" || mode === "keyword" || mode === "auto") {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    if (words.length) {
      const wordConds = words
        .map(() => `(m.title LIKE ? OR m.content LIKE ?)`)
        .join(" OR ");
      const params: any[] = [];
      for (const w of words) {
        params.push(`%${w}%`, `%${w}%`);
      }
      let sql = `SELECT DISTINCT m.* FROM memories m`;
      if (tag) {
        sql += ` JOIN tags t ON m.id = t.memory_id`;
      }
      sql += ` WHERE (${wordConds})`;
      if (tag) {
        sql += ` AND t.tag = ?`;
        params.push(tag.toLowerCase());
      }
      if (project) {
        sql += ` AND m.project = ?`;
        params.push(project);
      }
      if (type) {
        sql += ` AND m.type = ?`;
        params.push(type);
      }
      sql += ` ORDER BY m.created_at DESC LIMIT ?`;
      params.push(limit);
      kwResults = queryAll(sql, params);
      for (const row of kwResults) row.tags = getTagsForMemory(row.id);
    }
  }

  // Vector search (if keyword found few results)
  if (
    (mode === "vector" || (mode === "auto" && kwResults.length < 3)) &&
    GEMINI_API_KEY
  ) {
    vecResults = await vectorSearch(query, limit, project);
  }

  // Merge
  if (vecResults.length && kwResults.length) {
    const kwIds = new Set(kwResults.map((r) => r.id));
    const extra = vecResults
      .filter((r) => !kwIds.has(r.id))
      .map((r) => r.id);
    if (extra.length) kwResults = [...kwResults, ...getByIds(extra)];
    return formatRows(
      kwResults.slice(0, limit),
      `Search: "${query}" (Keyword+Vector)`
    );
  }
  if (vecResults.length) {
    return formatRows(
      getByIds(vecResults.map((r) => r.id)).slice(0, limit),
      `Search: "${query}" (Vector)`
    );
  }
  return formatRows(kwResults.slice(0, limit), `Search: "${query}" (Keyword)`);
}

async function handleGet(args: Record<string, any>) {
  const ids: number[] = args.ids;
  if (!ids?.length) return err("ids array is required");
  return formatRows(getByIds(ids), `Fetched ${ids.length} memories`);
}

async function handleList(args: Record<string, any>) {
  const limit = args.limit || 20;
  const project = args.project;
  const type = args.type;
  const tag = args.tag;

  if (tag) {
    let sql = `SELECT m.* FROM memories m JOIN tags t ON m.id = t.memory_id WHERE t.tag = ?`;
    const params: any[] = [tag.toLowerCase()];
    if (project) {
      sql += ` AND m.project = ?`;
      params.push(project);
    }
    if (type) {
      sql += ` AND m.type = ?`;
      params.push(type);
    }
    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = queryAll(sql, params);
    for (const row of rows) row.tags = getTagsForMemory(row.id);
    return formatRows(rows, `Memories (tag: ${tag})`);
  }

  let sql = `SELECT * FROM memories`;
  const params: any[] = [];
  const conds: string[] = [];
  if (project) {
    conds.push(`project = ?`);
    params.push(project);
  }
  if (type) {
    conds.push(`type = ?`);
    params.push(type);
  }
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = queryAll(sql, params);
  for (const row of rows) row.tags = getTagsForMemory(row.id);
  return formatRows(rows, "Memories");
}

async function handleUpdate(args: Record<string, any>) {
  const id: number | undefined = args.id;
  if (!id) return err("id is required");

  const existing = getByIds([id]);
  if (!existing.length) return err(`Memory #${id} not found`);

  const now = Date.now();
  const updates: string[] = [];
  const params: any[] = [];

  if (args.text !== undefined || args.content !== undefined) {
    updates.push(`content = ?`);
    params.push(args.text || args.content);
  }
  if (args.title !== undefined) {
    updates.push(`title = ?`);
    params.push(args.title);
  }
  if (args.type !== undefined) {
    updates.push(`type = ?`);
    params.push(args.type);
  }
  if (args.project !== undefined) {
    updates.push(`project = ?`);
    params.push(args.project);
  }

  if (!updates.length && !args.tags) {
    return err("Nothing to update. Provide text, title, type, project, or tags.");
  }

  if (updates.length) {
    updates.push(`updated_at = ?`, `updated_iso = ?`);
    params.push(now, new Date(now).toISOString());
    params.push(id);
    runSql(`UPDATE memories SET ${updates.join(", ")} WHERE id = ?`, params);
  }

  // Update tags if provided
  if (args.tags !== undefined) {
    setTagsForMemory(id, args.tags || []);
  }

  persist();

  // Re-embed if content changed
  if ((args.text || args.content) && GEMINI_API_KEY) {
    const newContent = args.text || args.content;
    const newTitle = args.title || existing[0].title;
    getEmbedding(`${newTitle}\n${newContent}`).then((vec) => {
      if (vec) {
        runSql(
          `INSERT OR REPLACE INTO embeddings (memory_id, vector) VALUES (?, ?)`,
          [id, vec.buffer]
        );
        persist();
      }
    });
  }

  return ok(`Updated memory #${id}`);
}

async function handleDelete(args: Record<string, any>) {
  const ids: number[] = args.ids;
  if (!ids?.length) return err("ids array is required");

  const existing = getByIds(ids);
  if (!existing.length) return err("No matching memories found");

  const placeholders = ids.map(() => "?").join(",");
  runSql(`DELETE FROM memories WHERE id IN (${placeholders})`, ids);
  runSql(`DELETE FROM embeddings WHERE memory_id IN (${placeholders})`, ids);
  runSql(`DELETE FROM tags WHERE memory_id IN (${placeholders})`, ids);
  persist();

  return ok(
    `Deleted ${existing.length} memor${existing.length === 1 ? "y" : "ies"}: ${existing.map((r) => `#${r.id}`).join(", ")}`
  );
}

async function handleTags(args: Record<string, any>) {
  const project: string | undefined = args.project;

  let sql = `SELECT t.tag, COUNT(*) as count FROM tags t`;
  const params: any[] = [];
  if (project) {
    sql += ` JOIN memories m ON m.id = t.memory_id WHERE m.project = ?`;
    params.push(project);
  }
  sql += ` GROUP BY t.tag ORDER BY count DESC`;

  const rows = queryAll(sql, params);
  if (!rows.length) return ok("No tags found.");

  const lines = rows.map((r) => `  ${r.tag} (${r.count})`);
  return ok(`# Tags (${rows.length})\n\n${lines.join("\n")}`);
}

// ---- MCP Server -----------------------------------------------------------
const server = new Server(
  { name: "mcp-simple-memory", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "mem_save",
    description:
      "Save a memory with optional tags. Params: text (required), title, project, type, tags[]",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Content to save" },
        title: {
          type: "string",
          description: "Short title (auto-generated if omitted)",
        },
        project: {
          type: "string",
          description: "Project name (default: 'default')",
        },
        type: {
          type: "string",
          description:
            "Type: memory, decision, error, session_summary, todo, snippet",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization (e.g. ['bug', 'auth'])",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "mem_search",
    description:
      "Search memories by keyword, meaning, tag, or type. Params: query, limit, project, mode, tag, type",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (omit for recent)",
        },
        limit: { type: "number", description: "Max results (default: 20)" },
        project: { type: "string", description: "Filter by project" },
        mode: {
          type: "string",
          description: "keyword, vector, or auto (default: auto)",
        },
        tag: { type: "string", description: "Filter by tag" },
        type: { type: "string", description: "Filter by type" },
      },
    },
  },
  {
    name: "mem_get",
    description: "Fetch full details for specific memory IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Memory IDs to fetch",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "mem_list",
    description:
      "List recent memories. Filter by project, type, or tag.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
        project: { type: "string", description: "Filter by project" },
        type: { type: "string", description: "Filter by type" },
        tag: { type: "string", description: "Filter by tag" },
      },
    },
  },
  {
    name: "mem_update",
    description:
      "Update an existing memory. Params: id (required), text, title, type, project, tags[]",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory ID to update" },
        text: { type: "string", description: "New content" },
        title: { type: "string", description: "New title" },
        type: { type: "string", description: "New type" },
        project: { type: "string", description: "New project" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replace all tags (pass [] to clear)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "mem_delete",
    description: "Delete memories by IDs. Also removes embeddings and tags.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Memory IDs to delete",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "mem_tags",
    description: "List all tags with their usage counts. Optionally filter by project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Filter by project" },
      },
    },
  },
];

const handlers: Record<string, (args: any) => Promise<any>> = {
  mem_save: handleSave,
  mem_search: handleSearch,
  mem_get: handleGet,
  mem_list: handleList,
  mem_update: handleUpdate,
  mem_delete: handleDelete,
  mem_tags: handleTags,
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = handlers[request.params.name];
  if (!handler) throw new Error(`Unknown tool: ${request.params.name}`);
  try {
    return await handler(request.params.arguments || {});
  } catch (error) {
    return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// ---- Start ----------------------------------------------------------------
console.log = console.error; // MCP uses stdout for JSON-RPC

async function main() {
  await initDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp-simple-memory] v0.2.0 | DB: ${DB_PATH} | Embeddings: ${GEMINI_API_KEY ? "ON" : "OFF"}`
  );
}

main().catch((e) => {
  console.error(`[mcp-simple-memory] Fatal: ${e}`);
  process.exit(1);
});
