# mcp-simple-memory

[![npm version](https://img.shields.io/npm/v/mcp-simple-memory.svg)](https://www.npmjs.com/package/mcp-simple-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

**Persistent memory for Claude Code. One command setup. Zero external databases.**

Claude Code forgets everything between sessions. This MCP server gives it a local SQLite memory that persists across sessions - with optional semantic search powered by Gemini embeddings.

## Features

- **Zero external dependencies** - SQLite via WASM (sql.js). No Python, no Docker, no ChromaDB
- **Cross-platform** - Works on Windows, macOS, and Linux
- **One command setup** - `npx mcp-simple-memory init` and restart Claude Code
- **Keyword + semantic search** - Auto-switches between SQLite LIKE queries and Gemini vector search
- **Tags & projects** - Organize memories by project, type, and custom tags
- **Markdown import** - Bulk import existing docs, notes, or session logs
- **~600 lines** - Small, auditable codebase. No magic

## Quick Start

```bash
npx mcp-simple-memory init
```

Restart Claude Code. You now have 7 tools: `mem_save`, `mem_search`, `mem_get`, `mem_list`, `mem_update`, `mem_delete`, `mem_tags`.

### Add Semantic Search (Optional)

Get a free [Gemini API key](https://aistudio.google.com/apikey) (1500 requests/day free tier), then edit `.mcp.json`:

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

Without a key, keyword search works fine. With a key, vector search kicks in automatically when keyword results are sparse.

## Use Cases

**Session memory** - Save summaries at the end of each session, pick up where you left off next time:
```
mem_save({ text: "Migrated auth from JWT to OAuth2. Tests passing.", type: "session_summary", project: "my-app" })
```

**Technical decisions** - Remember why you chose X over Y:
```
mem_save({ text: "Chose Postgres over MongoDB because we need transactions for payment flow", type: "decision", tags: ["database", "payments"] })
```

**Error solutions** - Never debug the same issue twice:
```
mem_save({ text: "CORS error on /api/upload fixed by adding credentials: 'include'", type: "error", tags: ["cors", "api"] })
```

**Cross-session search** - Find anything from previous sessions:
```
mem_search({ query: "authentication", tag: "api" })
```

## Tools Reference

### `mem_save`
Save a memory with optional tags.

| Param | Required | Description |
|-------|----------|-------------|
| text | Yes | Content to save |
| title | No | Short title (auto-generated if omitted) |
| project | No | Project name (default: "default") |
| type | No | memory, decision, error, session_summary, todo, snippet |
| tags | No | Array of tags for categorization |

### `mem_search`
Search by keyword, meaning, tag, or type.

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
Update an existing memory.

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

| Param | Required | Description |
|-------|----------|-------------|
| ids | Yes | Array of memory IDs to delete |

### `mem_tags`
List all tags with usage counts.

| Param | Required | Description |
|-------|----------|-------------|
| project | No | Filter by project |

## How It Works

```
mem_save({ text: "Fixed auth bug", tags: ["bug"] })
    |
    v
SQLite (keyword index + optional Gemini embedding + tags)
    |
    v
mem_search({ query: "authentication problem" })
    -> keyword match OR vector similarity
```

1. **Keyword Search** - SQLite LIKE queries. Fast, zero-config, always available.
2. **Gemini Embeddings** (optional) - 3072-dim vectors for semantic similarity. Finds "authentication" when you searched "login issue".
3. **Auto mode** - Keyword first. If < 3 results, falls back to vector search.
4. **Tags** - Lightweight categorization. Normalized to lowercase.

## Import Existing Knowledge

Already have notes, docs, or session logs? Import them:

```bash
# Import a single markdown file
npx mcp-simple-memory import CLAUDE.md --project my-app --tags setup

# Import all .md files in a directory
npx mcp-simple-memory import ./docs --tags documentation

# Preview without saving
npx mcp-simple-memory import ./notes --dry-run

# With embeddings (auto-generates during import)
GEMINI_API_KEY=your-key npx mcp-simple-memory import memory.md
```

Files are split by headings (`#`, `##`, `###`) into individual memories.

| Flag | Description |
|------|-------------|
| `--project <name>` | Set project name (default: filename) |
| `--tags <t1,t2>` | Add tags to all imported memories |
| `--dry-run` | Preview without saving |

## Database Stats

```bash
npx mcp-simple-memory stats
```

```
mcp-simple-memory stats
  DB: ~/.mcp-simple-memory/memory.db

  Memories:   42
  Embeddings: 42/42 (100%)
  Tags:       15 unique

  Projects:
    my-app: 30
    default: 12
```

## Use with CLAUDE.md

Add to your project's `CLAUDE.md` for automatic session continuity:

```markdown
## Session Memory
- On session start: `mem_search` for recent session summaries
- During work: `mem_save` important decisions (type: "decision")
- On session end: `mem_save` a summary (type: "session_summary")
```

## Data Storage

All data stays local on your machine:
- **Database**: `~/.mcp-simple-memory/memory.db`
- **Override**: set `MCP_MEMORY_DIR` environment variable

## Comparison with Other Memory MCPs

| | mcp-simple-memory | Official Memory Server | Others (ChromaDB-based) |
|---|---|---|---|
| Setup | `npx` one-liner | Config required | Python + Docker + DB |
| Storage | SQLite (WASM) | JSON file | External vector DB |
| Search | Keyword + Vector | Graph traversal | Vector only |
| Windows | Yes | Yes | Often broken |
| Dependencies | 2 (sdk + sql.js) | Varies | Many |
| Semantic search | Optional (Gemini free tier) | No | Required |

## Upgrading

Just update - the database schema migrates automatically. Existing memories are preserved.

## License

MIT
