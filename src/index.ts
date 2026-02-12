#!/usr/bin/env node
/**
 * mcp-simple-memory — Persistent memory for Claude Code
 *
 * ~450 lines. SQLite (sql.js WASM, zero native deps).
 * Optional Gemini semantic search. Works on Windows/Mac/Linux.
 *
 * Tools:
 *   mem_save   — Save a memory
 *   mem_search — Search (keyword + optional vector)
 *   mem_get    — Fetch by IDs
 *   mem_list   — Recent memories
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

// ─── Config ────────────────────────────────────────────────────
const DATA_DIR = process.env.MCP_MEMORY_DIR || join(homedir(), ".mcp-simple-memory");
const DB_PATH = join(DATA_DIR, "memory.db");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMS = 3072;

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Database ──────────────────────────────────────────────────
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
      created_iso TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type);`);
  persist();
}

function persist() {
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// ─── Query helper ──────────────────────────────────────────────
function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getByIds(ids: number[]): any[] {
  if (!ids.length) return [];
  return queryAll(
    `SELECT * FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
}

// ─── Gemini Embeddings ─────────────────────────────────────────
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
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

async function vectorSearch(query: string, limit: number, project?: string) {
  const qVec = await getEmbedding(query);
  if (!qVec) return [];

  const sql = project
    ? `SELECT e.memory_id, e.vector FROM embeddings e JOIN memories m ON m.id = e.memory_id WHERE m.project = ?`
    : `SELECT memory_id, vector FROM embeddings`;
  const rows = queryAll(sql, project ? [project] : []);

  const scored = rows.map((r) => {
    const buf = r.vector instanceof Uint8Array ? r.vector : new Uint8Array(r.vector);
    const vec = new Float32Array(buf.buffer, buf.byteOffset, EMBEDDING_DIMS);
    return { id: r.memory_id, score: cosine(qVec, vec) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─── Response helpers ──────────────────────────────────────────
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
    return `#${r.id} | ${r.type} | ${r.project} | ${r.created_iso}\n  ${r.title || "(no title)"}\n  ${preview}`;
  });
  return ok(`# ${header} (${rows.length})\n\n${lines.join("\n\n")}`);
}

// ─── Tool Handlers ─────────────────────────────────────────────
async function handleSave(args: Record<string, any>) {
  const content = args.text || args.content;
  if (!content) return err("text is required");

  const now = Date.now();
  const title = args.title || content.substring(0, 80);
  const project = args.project || "default";
  const type = args.type || "memory";

  db.run(
    `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
    [title, content, type, project, now, new Date(now).toISOString()]
  );
  const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id ?? 0;
  persist();

  // Background embedding
  if (GEMINI_API_KEY) {
    getEmbedding(`${title}\n${content}`).then((vec) => {
      if (vec) {
        db.run(`INSERT OR REPLACE INTO embeddings (memory_id, vector) VALUES (?, ?)`, [
          id,
          vec.buffer,
        ]);
        persist();
      }
    });
  }

  return ok(`Saved memory #${id} (project: ${project})`);
}

async function handleSearch(args: Record<string, any>) {
  const query: string | undefined = args.query;
  const limit: number = args.limit || 20;
  const project: string | undefined = args.project;
  const mode: string = args.mode || "auto";

  // No query → return recent
  if (!query) {
    const sql = project
      ? `SELECT * FROM memories WHERE project = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`;
    return formatRows(queryAll(sql, project ? [project, limit] : [limit]), "Recent memories");
  }

  let kwResults: any[] = [];
  let vecResults: Array<{ id: number; score: number }> = [];

  // Keyword search (LIKE)
  if (mode === "fts" || mode === "keyword" || mode === "auto") {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    if (words.length) {
      const conds = words.map(() => `(title LIKE ? OR content LIKE ?)`).join(" OR ");
      const params: any[] = [];
      for (const w of words) { params.push(`%${w}%`, `%${w}%`); }
      let sql = `SELECT * FROM memories WHERE (${conds})`;
      if (project) { sql += ` AND project = ?`; params.push(project); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      kwResults = queryAll(sql, params);
    }
  }

  // Vector search (if keyword found few results)
  if ((mode === "vector" || (mode === "auto" && kwResults.length < 3)) && GEMINI_API_KEY) {
    vecResults = await vectorSearch(query, limit, project);
  }

  // Merge
  if (vecResults.length && kwResults.length) {
    const kwIds = new Set(kwResults.map((r) => r.id));
    const extra = vecResults.filter((r) => !kwIds.has(r.id)).map((r) => r.id);
    if (extra.length) kwResults = [...kwResults, ...getByIds(extra)];
    return formatRows(kwResults.slice(0, limit), `Search: "${query}" (Keyword+Vector)`);
  }
  if (vecResults.length) {
    return formatRows(getByIds(vecResults.map((r) => r.id)).slice(0, limit), `Search: "${query}" (Vector)`);
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
  const sql = project
    ? `SELECT * FROM memories WHERE project = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`;
  return formatRows(queryAll(sql, project ? [project, limit] : [limit]), "Memories");
}

// ─── MCP Server ────────────────────────────────────────────────
const server = new Server(
  { name: "mcp-simple-memory", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "mem_save",
    description: "Save a memory. Params: text (required), title, project, type (memory/decision/error/session_summary)",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Content to save" },
        title: { type: "string", description: "Short title (auto-generated if omitted)" },
        project: { type: "string", description: "Project name (default: 'default')" },
        type: { type: "string", description: "Type: memory, decision, error, session_summary" },
      },
      required: ["text"],
    },
  },
  {
    name: "mem_search",
    description: "Search memories by keyword or meaning. Params: query, limit, project, mode (keyword/vector/auto)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (omit for recent)" },
        limit: { type: "number", description: "Max results (default: 20)" },
        project: { type: "string", description: "Filter by project" },
        mode: { type: "string", description: "keyword, vector, or auto (default: auto)" },
      },
    },
  },
  {
    name: "mem_get",
    description: "Fetch full details for specific memory IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "Memory IDs to fetch" },
      },
      required: ["ids"],
    },
  },
  {
    name: "mem_list",
    description: "List recent memories. Params: limit, project",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
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
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
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

// ─── Start ─────────────────────────────────────────────────────
console.log = console.error; // MCP uses stdout for JSON-RPC

async function main() {
  await initDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp-simple-memory] DB: ${DB_PATH} | Embeddings: ${GEMINI_API_KEY ? "ON" : "OFF"}`);
}

main().catch((e) => {
  console.error(`[mcp-simple-memory] Fatal: ${e}`);
  process.exit(1);
});
