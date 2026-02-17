#!/usr/bin/env node
/**
 * mcp-simple-memory VPS proxy
 *
 * ローカルSQLiteの代わりにVPS HTTP APIを叩くMCPサーバー。
 * PC/iPhone両方から同じDBを使えるようになる。
 *
 * 環境変数:
 *   MCP_MEMORY_API_URL - VPSのベースURL（デフォルト: http://133.117.72.109:3100）
 *   MCP_MEMORY_API_KEY - VPS APIの認証キー（デフォルト: mic-api-2024-secret）
 *
 * ツールは元のmcp-simple-memoryと完全互換:
 *   mem_save, mem_search, mem_get, mem_list, mem_update, mem_delete, mem_tags
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---- Config ---------------------------------------------------------------
const API_BASE = (process.env.MCP_MEMORY_API_URL || "http://133.117.72.109:3100").replace(/\/$/, "");
const API_KEY = process.env.MCP_MEMORY_API_KEY || "mic-api-2024-secret";

// 全リクエストに付与する共通ヘッダー
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-api-key": API_KEY, ...extra };
}

// ---- HTTP helpers ---------------------------------------------------------
async function apiGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(path: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPut(path: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiDelete(path: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---- Response helpers -----------------------------------------------------
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// VPS APIの返すmemoriesをmcp-simple-memory互換の表示フォーマットに変換
function formatRows(memories: any[], header: string) {
  if (!memories || !memories.length) return ok(`${header}\n\n(no results)`);
  const lines = memories.map((r: any) => {
    const preview = (r.content || "").substring(0, 200).replace(/\n/g, " ");
    const tags = r.tags?.length ? ` [${r.tags.join(", ")}]` : "";
    const updated = r.updated_iso ? ` (updated: ${r.updated_iso})` : "";
    return `#${r.id} | ${r.type} | ${r.project} | ${r.created_iso}${updated}\n  ${r.title || "(no title)"}${tags}\n  ${preview}`;
  });
  return ok(`# ${header} (${memories.length})\n\n${lines.join("\n\n")}`);
}

// ---- Tool Handlers --------------------------------------------------------

async function handleSave(args: Record<string, any>) {
  const text = args.text || args.content;
  if (!text) return err("text is required");

  const data = await apiPost("/memory/save", {
    text,
    title: args.title,
    project: args.project || "default",
    type: args.type || "memory",
    tags: args.tags || [],
  });

  const tagStr = args.tags?.length ? ` tags: [${args.tags.join(", ")}]` : "";
  return ok(`Saved memory #${data.id} (project: ${args.project || "default"})${tagStr}`);
}

async function handleSearch(args: Record<string, any>) {
  const query = args.query;
  const params: Record<string, string> = {};
  if (query) params.q = query;
  if (args.limit) params.limit = String(args.limit);
  if (args.project) params.project = args.project;
  if (args.type) params.type = args.type;
  if (args.tag) params.tag = args.tag;

  // queryなし → listにフォールバック（VPS searchはquery必須）
  if (!query) {
    const data = await apiGet("/memory/list", params);
    return formatRows(data.memories, "Recent memories");
  }

  const data = await apiGet("/memory/search", params);
  return formatRows(data.memories, `Search: "${query}" (Keyword)`);
}

async function handleGet(args: Record<string, any>) {
  const ids: number[] = args.ids;
  if (!ids?.length) return err("ids array is required");

  const data = await apiGet("/memory/get", { ids: ids.join(",") });
  return formatRows(data.memories, `Fetched ${ids.length} memories`);
}

async function handleList(args: Record<string, any>) {
  const params: Record<string, string> = {};
  if (args.limit) params.limit = String(args.limit);
  if (args.project) params.project = args.project;
  if (args.type) params.type = args.type;
  if (args.tag) params.tag = args.tag;

  const data = await apiGet("/memory/list", params);
  const header = args.tag ? `Memories (tag: ${args.tag})` : "Memories";
  return formatRows(data.memories, header);
}

async function handleUpdate(args: Record<string, any>) {
  const id = args.id;
  if (!id) return err("id is required");

  const body: Record<string, any> = { id };
  if (args.text !== undefined || args.content !== undefined) body.text = args.text || args.content;
  if (args.title !== undefined) body.title = args.title;
  if (args.type !== undefined) body.type = args.type;
  if (args.project !== undefined) body.project = args.project;
  if (args.tags !== undefined) body.tags = args.tags;

  await apiPut("/memory/update", body);
  return ok(`Updated memory #${id}`);
}

async function handleDelete(args: Record<string, any>) {
  const ids: number[] = args.ids;
  if (!ids?.length) return err("ids array is required");

  const data = await apiDelete("/memory/delete", { ids });
  return ok(`Deleted ${data.deleted} memor${data.deleted === 1 ? "y" : "ies"}: ${ids.map(id => `#${id}`).join(", ")}`);
}

async function handleTags(args: Record<string, any>) {
  const params: Record<string, string> = {};
  if (args.project) params.project = args.project;

  const data = await apiGet("/memory/tags", params);
  if (!data.tags?.length) return ok("No tags found.");

  const lines = data.tags.map((r: any) => `  ${r.tag} (${r.count})`);
  return ok(`# Tags (${data.tags.length})\n\n${lines.join("\n")}`);
}

// ---- MCP Server -----------------------------------------------------------
const server = new Server(
  { name: "mcp-simple-memory", version: "0.5.0-vps" },
  { capabilities: { tools: {} } }
);

// ツール定義は元のmcp-simple-memoryと完全に同じ
const tools = [
  {
    name: "mem_save",
    description:
      "Save a memory with optional tags. Params: text (required), title, project, type, tags[]",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Content to save" },
        title: { type: "string", description: "Short title (auto-generated if omitted)" },
        project: { type: "string", description: "Project name (default: 'default')" },
        type: { type: "string", description: "Type: memory, decision, error, session_summary, todo, snippet" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization (e.g. ['bug', 'auth'])" },
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
        query: { type: "string", description: "Search query (omit for recent)" },
        limit: { type: "number", description: "Max results (default: 20)" },
        project: { type: "string", description: "Filter by project" },
        mode: { type: "string", description: "keyword, vector, or auto (default: auto)" },
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
        ids: { type: "array", items: { type: "number" }, description: "Memory IDs to fetch" },
      },
      required: ["ids"],
    },
  },
  {
    name: "mem_list",
    description: "List recent memories. Filter by project, type, or tag.",
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
    description: "Update an existing memory. Params: id (required), text, title, type, project, tags[]",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Memory ID to update" },
        text: { type: "string", description: "New content" },
        title: { type: "string", description: "New title" },
        type: { type: "string", description: "New type" },
        project: { type: "string", description: "New project" },
        tags: { type: "array", items: { type: "string" }, description: "Replace all tags (pass [] to clear)" },
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
        ids: { type: "array", items: { type: "number" }, description: "Memory IDs to delete" },
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
    const msg = error instanceof Error ? error.message : String(error);
    // VPS接続エラーの場合、分かりやすくする
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      return err(`VPS接続エラー: ${API_BASE} に接続できません。VPSが起動しているか確認してください。\n${msg}`);
    }
    return err(`Error: ${msg}`);
  }
});

// ---- Start ----------------------------------------------------------------
console.log = console.error; // MCP uses stdout for JSON-RPC

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp-simple-memory] v0.5.0-vps | API: ${API_BASE} | No local DB`);
}

main().catch((e) => {
  console.error(`[mcp-simple-memory] Fatal: ${e}`);
  process.exit(1);
});
