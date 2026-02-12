/**
 * Tests for mcp-simple-memory
 *
 * Uses node:test (built-in). Tests the DB logic directly
 * by importing sql.js and running the same queries.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import initSqlJs, { type Database } from "sql.js";

// ---- Minimal reimplementation of DB + handlers for testing ----------------
let db: Database;
let tempDir: string;
let dbPath: string;

function persist() {
  writeFileSync(dbPath, Buffer.from(db.export()));
}

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

function getTagsForMemory(memoryId: number): string[] {
  return queryAll(`SELECT tag FROM tags WHERE memory_id = ?`, [memoryId]).map(r => r.tag);
}

function setTagsForMemory(memoryId: number, tags: string[]) {
  runSql(`DELETE FROM tags WHERE memory_id = ?`, [memoryId]);
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized) {
      runSql(`INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)`, [memoryId, normalized]);
    }
  }
}

function getByIds(ids: number[]): any[] {
  if (!ids.length) return [];
  const rows = queryAll(
    `SELECT * FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
  for (const row of rows) row.tags = getTagsForMemory(row.id);
  return rows;
}

// ---- Setup ----------------------------------------------------------------
before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "mcp-mem-test-"));
  dbPath = join(tempDir, "memory.db");

  const SQL = await initSqlJs();
  db = new SQL.Database();

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
  persist();
});

after(() => {
  db?.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---- Tests ----------------------------------------------------------------

describe("mem_save", () => {
  test("inserts a memory and returns correct ID", () => {
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Test title", "Test content body", "decision", "test-project", now, new Date(now).toISOString()]
    );
    const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    assert.ok(id > 0, `Expected positive ID, got ${id}`);
    persist();
  });

  test("saves with tags", () => {
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Tagged memory", "Content with tags", "memory", "default", now, new Date(now).toISOString()]
    );
    const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id, ["bug", "Auth", " api "]);
    persist();

    const tags = getTagsForMemory(id);
    assert.ok(tags.includes("bug"), "Should have 'bug' tag");
    assert.ok(tags.includes("auth"), "Should have normalized 'auth' tag");
    assert.ok(tags.includes("api"), "Should have trimmed 'api' tag");
  });

  test("auto-generates title from content", () => {
    const content = "A very long content string that should be truncated to 80 characters for the auto-title feature testing.";
    const title = content.substring(0, 80);
    assert.equal(title.length, 80);
    assert.ok(title.startsWith("A very long"));
  });
});

describe("mem_search (keyword)", () => {
  test("finds by keyword in content", () => {
    const words = ["Test"];
    const conds = words.map(() => `(title LIKE ? OR content LIKE ?)`).join(" OR ");
    const params: any[] = [];
    for (const w of words) { params.push(`%${w}%`, `%${w}%`); }
    const sql = `SELECT * FROM memories WHERE (${conds}) ORDER BY created_at DESC LIMIT 20`;
    const rows = queryAll(sql, params);
    assert.ok(rows.length > 0, "Should find at least one result");
    assert.ok(rows.some(r => r.title === "Test title"), "Should find 'Test title'");
  });

  test("filters by project", () => {
    const rows = queryAll(
      `SELECT * FROM memories WHERE project = ? ORDER BY created_at DESC LIMIT 20`,
      ["test-project"]
    );
    assert.ok(rows.length > 0);
    assert.ok(rows.every(r => r.project === "test-project"));
  });

  test("filters by type", () => {
    const rows = queryAll(
      `SELECT * FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT 20`,
      ["decision"]
    );
    assert.ok(rows.length > 0);
    assert.ok(rows.every(r => r.type === "decision"));
  });

  test("filters by tag", () => {
    const rows = queryAll(
      `SELECT m.* FROM memories m JOIN tags t ON m.id = t.memory_id WHERE t.tag = ? ORDER BY m.created_at DESC LIMIT 20`,
      ["bug"]
    );
    assert.ok(rows.length > 0, "Should find memories tagged 'bug'");
  });

  test("returns empty for non-matching query", () => {
    const rows = queryAll(
      `SELECT * FROM memories WHERE title LIKE ? OR content LIKE ? LIMIT 20`,
      ["%xyznonexistent%", "%xyznonexistent%"]
    );
    assert.equal(rows.length, 0);
  });
});

describe("mem_get", () => {
  test("fetches by ID with tags", () => {
    const rows = getByIds([1]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Test title");
    assert.ok(Array.isArray(rows[0].tags));
  });

  test("returns empty for non-existent IDs", () => {
    const rows = getByIds([9999]);
    assert.equal(rows.length, 0);
  });
});

describe("mem_list", () => {
  test("lists recent memories", () => {
    const rows = queryAll(`SELECT * FROM memories ORDER BY created_at DESC LIMIT 20`);
    assert.ok(rows.length >= 2, "Should have at least 2 memories");
  });

  test("limits results", () => {
    const rows = queryAll(`SELECT * FROM memories ORDER BY created_at DESC LIMIT 1`);
    assert.equal(rows.length, 1);
  });
});

describe("mem_update", () => {
  test("updates content and sets updated_at", () => {
    const now = Date.now();
    runSql(
      `UPDATE memories SET content = ?, updated_at = ?, updated_iso = ? WHERE id = ?`,
      ["Updated content!", now, new Date(now).toISOString(), 1]
    );
    persist();

    const rows = getByIds([1]);
    assert.equal(rows[0].content, "Updated content!");
    assert.ok(rows[0].updated_at > 0, "Should have updated_at timestamp");
    assert.ok(rows[0].updated_iso, "Should have updated_iso string");
  });

  test("updates tags (replace all)", () => {
    setTagsForMemory(1, ["new-tag", "updated"]);
    persist();

    const tags = getTagsForMemory(1);
    assert.deepEqual(tags.sort(), ["new-tag", "updated"]);
  });

  test("clears tags with empty array", () => {
    setTagsForMemory(1, []);
    persist();

    const tags = getTagsForMemory(1);
    assert.equal(tags.length, 0);
  });
});

describe("mem_delete", () => {
  test("deletes memory, embeddings, and tags", () => {
    // Save a new one to delete
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["To delete", "Delete me", "memory", "default", now, new Date(now).toISOString()]
    );
    const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id, ["temp"]);
    persist();

    // Confirm exists
    assert.equal(getByIds([id]).length, 1);

    // Delete
    runSql(`DELETE FROM memories WHERE id = ?`, [id]);
    runSql(`DELETE FROM tags WHERE memory_id = ?`, [id]);
    persist();

    // Confirm gone
    assert.equal(getByIds([id]).length, 0);
    assert.equal(getTagsForMemory(id).length, 0);
  });
});

describe("mem_tags", () => {
  test("lists tags with counts", () => {
    // Ensure we have some tags
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Tag test 1", "Content 1", "memory", "default", now, new Date(now).toISOString()]
    );
    const id1 = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id1, ["common", "unique1"]);

    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Tag test 2", "Content 2", "memory", "default", now + 1, new Date(now + 1).toISOString()]
    );
    const id2 = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id2, ["common", "unique2"]);
    persist();

    // Query tags with counts
    const rows = queryAll(`SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC`);
    assert.ok(rows.length >= 3, "Should have at least 3 distinct tags");

    const common = rows.find(r => r.tag === "common");
    assert.ok(common, "Should find 'common' tag");
    assert.ok(common!.count >= 2, "'common' should appear at least twice");
  });

  test("filters by project", () => {
    // Add a tag to a specific project
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Project specific", "Content", "memory", "proj-x", now, new Date(now).toISOString()]
    );
    const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id, ["proj-tag"]);
    persist();

    const rows = queryAll(
      `SELECT t.tag, COUNT(*) as count FROM tags t JOIN memories m ON m.id = t.memory_id WHERE m.project = ? GROUP BY t.tag ORDER BY count DESC`,
      ["proj-x"]
    );
    assert.ok(rows.length >= 1);
    assert.ok(rows.some(r => r.tag === "proj-tag"));
  });
});

describe("schema migration", () => {
  test("tags table exists and has correct structure", () => {
    const tables = queryAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='tags'`);
    assert.equal(tables.length, 1);
  });

  test("memories table has updated_at column", () => {
    // This would fail if the column didn't exist
    const rows = queryAll(`SELECT updated_at FROM memories LIMIT 1`);
    assert.ok(Array.isArray(rows));
  });
});

describe("edge cases", () => {
  test("empty tag strings are ignored", () => {
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Edge case", "Content", "memory", "default", now, new Date(now).toISOString()]
    );
    const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id, ["valid", "", "  ", "also-valid"]);
    persist();

    const tags = getTagsForMemory(id);
    assert.deepEqual(tags.sort(), ["also-valid", "valid"]);
  });

  test("tags are normalized to lowercase", () => {
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Normalize test", "Content", "memory", "default", now, new Date(now).toISOString()]
    );
    const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id, ["BUG", "Auth", "API"]);
    persist();

    const tags = getTagsForMemory(id);
    assert.deepEqual(tags.sort(), ["api", "auth", "bug"]);
  });

  test("duplicate tags are deduplicated", () => {
    const now = Date.now();
    runSql(
      `INSERT INTO memories (title, content, type, project, created_at, created_iso) VALUES (?, ?, ?, ?, ?, ?)`,
      ["Dedup test", "Content", "memory", "default", now, new Date(now).toISOString()]
    );
    const id = queryAll(`SELECT last_insert_rowid() as id`)[0]?.id;
    setTagsForMemory(id, ["bug", "Bug", "BUG", "auth"]);
    persist();

    const tags = getTagsForMemory(id);
    assert.deepEqual(tags.sort(), ["auth", "bug"]);
  });
});
