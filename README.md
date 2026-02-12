# mcp-simple-memory

Persistent memory for Claude Code. **One file, zero external databases.**

Claude Code forgets everything between sessions. This MCP server gives it a local SQLite memory that persists forever.

## Why This Exists

| | claude-mem | mcp-simple-memory |
|---|-----------|-------------------|
| Codebase | ~20,000 lines | ~600 lines |
| External DB | ChromaDB + Python | None (SQLite built-in) |
| Windows | Broken (as of v10) | Works |
| Setup | Complex | 1 command |
| Search | Vector only | Keyword + optional vector |

## Quick Start

```bash
npx mcp-simple-memory init
```

Restart Claude Code. Done. You now have 7 tools: `mem_save`, `mem_search`, `mem_get`, `mem_list`, `mem_update`, `mem_delete`, `mem_tags`.

## Optional: Semantic Search

Add a free [Gemini API key](https://aistudio.google.com/apikey) for meaning-based search:

Edit `.mcp.json`:
```json
{
  "mcpServers": {
    "mcp-simple-memory": {
      "command": "npx",
      "args": ["-y", "mcp-simple-memory", "serve"],
      "env": {
        "GEMINI_API_KEY": "your-key-here"
      }
    }
  }
}
```

Without a key, keyword search is used. With a key, vector search kicks in automatically when keyword results are sparse.

## Tools

### `mem_save`
Save a memory with optional tags.

```
mem_save({ text: "OAuth2 tokens expire in 1 hour", tags: ["auth", "api"] })
```

| Param | Required | Description |
|-------|----------|-------------|
| text | Yes | Content to save |
| title | No | Short title (auto-generated) |
| project | No | Project name (default: "default") |
| type | No | memory, decision, error, session_summary, todo, snippet |
| tags | No | Array of tags for categorization |

### `mem_search`
Search by keyword, meaning, tag, or type.

```
mem_search({ query: "authentication", tag: "api" })
```

| Param | Required | Description |
|-------|----------|-------------|
| query | No | Search query (omit for recent) |
| limit | No | Max results (default: 20) |
| project | No | Filter by project |
| mode | No | keyword, vector, auto (default: auto) |
| tag | No | Filter by tag |
| type | No | Filter by type |

### `mem_get`
Fetch full details by ID.

| Param | Required | Description |
|-------|----------|-------------|
| ids | Yes | Array of memory IDs |

### `mem_list`
List recent memories with optional filters.

| Param | Required | Description |
|-------|----------|-------------|
| limit | No | Max results (default: 20) |
| project | No | Filter by project |
| type | No | Filter by type |
| tag | No | Filter by tag |

### `mem_update`
Update an existing memory's content, title, type, project, or tags.

```
mem_update({ id: 42, text: "Updated content", tags: ["new-tag"] })
```

| Param | Required | Description |
|-------|----------|-------------|
| id | Yes | Memory ID to update |
| text | No | New content |
| title | No | New title |
| type | No | New type |
| project | No | New project |
| tags | No | Replace all tags (pass [] to clear) |

### `mem_delete`
Delete memories by IDs. Also removes embeddings and tags.

```
mem_delete({ ids: [1, 2, 3] })
```

| Param | Required | Description |
|-------|----------|-------------|
| ids | Yes | Array of memory IDs to delete |

### `mem_tags`
List all tags with usage counts.

```
mem_tags({ project: "my-app" })
```

| Param | Required | Description |
|-------|----------|-------------|
| project | No | Filter by project |

## How It Works

```
mem_save({ text: "Fixed auth bug with OAuth2", tags: ["bug", "auth"] })
    |
    v
SQLite (keyword index + optional Gemini embedding + tags)
    |
    v
mem_search({ query: "authentication problem", tag: "bug" })
    -> Finds it via keyword match OR vector similarity, filtered by tag
```

1. **Keyword Search**: SQLite LIKE queries. Fast, zero-config.
2. **Gemini Embeddings** (optional): 3072-dim vectors for semantic similarity. Free tier = 1500 req/day.
3. **Auto mode**: Keyword first. If < 3 results, falls back to vector search.
4. **Tags**: Lightweight categorization. Normalized to lowercase.

## Data Storage

All data stays local:
- Database: `~/.mcp-simple-memory/memory.db`
- Override: set `MCP_MEMORY_DIR` environment variable

## Use with CLAUDE.md

Add to your project's `CLAUDE.md` for automatic session memory:

```markdown
## Session Memory
- On session start: use `mem_search` to find recent session summaries
- During work: save important decisions with `mem_save` (type: "decision")
- On session end: save a summary with `mem_save` (type: "session_summary")
- Tag memories for easy retrieval: `mem_save({ text: "...", tags: ["auth", "v2"] })`
```

## Upgrade from 0.1.x

Just update - the database schema migrates automatically. Your existing memories are preserved. New columns (`updated_at`, `updated_iso`) and the `tags` table are added on first run.

## License

MIT
