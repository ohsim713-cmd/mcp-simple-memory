# mcp-simple-memory

Persistent memory for Claude Code. **~500 lines, 1 file, zero external databases.**

Claude Code forgets everything between sessions. This MCP server gives it a local SQLite memory that persists forever.

## Why not claude-mem?

| | claude-mem | mcp-simple-memory |
|---|-----------|-------------------|
| Codebase | ~20,000 lines | ~500 lines |
| External DB | ChromaDB + Python | None (SQLite built-in) |
| Windows | Broken (as of v10) | Works |
| Setup | Complex | 1 command |
| Search | Vector only | FTS5 + optional vector |

## Quick Start

```bash
# In your project directory:
npx mcp-simple-memory init
```

Restart Claude Code. Done. You now have `mem_save`, `mem_search`, `mem_get`, and `mem_list` tools.

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

Without a key, only FTS5 keyword search is used. With a key, the server automatically falls back to vector search when keyword search returns few results.

## Tools

### `mem_save`
Save a memory.

| Param | Required | Description |
|-------|----------|-------------|
| text | Yes | Content to save |
| title | No | Short title (auto-generated) |
| project | No | Project name (default: "default") |
| type | No | memory, decision, error, session_summary |

### `mem_search`
Search memories by keyword or meaning.

| Param | Required | Description |
|-------|----------|-------------|
| query | No | Search query (omit for recent) |
| limit | No | Max results (default: 20) |
| project | No | Filter by project |
| mode | No | fts, vector, auto (default: auto) |

### `mem_get`
Fetch full details by ID.

| Param | Required | Description |
|-------|----------|-------------|
| ids | Yes | Array of memory IDs |

### `mem_list`
List recent memories.

| Param | Required | Description |
|-------|----------|-------------|
| limit | No | Max results (default: 20) |
| project | No | Filter by project |

## How It Works

```
mem_save("Fixed the auth bug by switching to OAuth2")
    ↓
SQLite (FTS5 index + optional Gemini embedding)
    ↓
mem_search("authentication problem")
    → Finds it via FTS keyword match OR vector similarity
```

1. **FTS5**: SQLite full-text search. Fast, zero-config, keyword matching.
2. **Gemini Embeddings** (optional): Converts text to 3072-dim vectors for semantic similarity. Free tier = 1500 requests/day.
3. **Auto mode**: Tries FTS5 first. If < 3 results, falls back to vector search.

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
```

## License

MIT
