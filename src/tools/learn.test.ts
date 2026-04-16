/**
 * Tests for the learning gatekeeper, recall, and FTS search behaviour.
 *
 * The DB client is pointed at a tmp sqlite file per test via MEMORY_DB_PATH.
 * Each test creates a fresh DB so cases don't leak state into each other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We must set MEMORY_DB_PATH BEFORE the modules that import the singleton db.
let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'memdesk-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  // reset the singleton db so next test opens a fresh one
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('db bootstrap', () => {
  it('creates schema on first call and survives re-open', async () => {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('learnings');
    expect(names).toContain('decisions');
    expect(names).toContain('entities');
    expect(names).toContain('entity_observations');
    expect(names).toContain('entity_relations');
    expect(names).toContain('meta');
  });

  it('WAL mode is active', async () => {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('FTS5 virtual table exists and is queryable', async () => {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    // Querying a FTS5 table with an empty MATCH should not throw; FTS5
    // returns zero rows for missing tokens.
    expect(() => db.prepare("SELECT * FROM search_fts WHERE search_fts MATCH 'nonexistent' LIMIT 1").all()).not.toThrow();
  });
});

describe('learn gatekeeper', () => {
  it('inserts a brand new learning and returns added', async () => {
    const { learn } = await import('./learn.js');
    const result = learn({
      category: 'pattern',
      content: 'FTS5 search is cheap in SQLite when triggers keep the index warm.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { action: string; id: string };
      expect(data.action).toBe('added');
      expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('returns skipped_duplicate for exact re-insert', async () => {
    const { learn } = await import('./learn.js');
    const first = learn({ category: 'pattern', content: 'exactly the same sentence' });
    const second = learn({ category: 'pattern', content: 'exactly the same sentence' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (second.success) {
      const data = second.data as { action: string };
      expect(data.action).toBe('skipped_duplicate');
    }
  });

  it('auto-classifies mistake category as episodic memory', async () => {
    const { learn } = await import('./learn.js');
    const result = learn({
      category: 'mistake',
      content: 'I forgot to quote the fts query and it crashed on multi-word input.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { memoryType: string };
      expect(data.memoryType).toBe('episodic');
    }
  });

  it('auto-classifies architecture as semantic memory', async () => {
    const { learn } = await import('./learn.js');
    const result = learn({
      category: 'architecture',
      content: 'The bundle ships a platform-specific native binding per OS.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { memoryType: string };
      expect(data.memoryType).toBe('semantic');
    }
  });
});

describe('recall + search', () => {
  it('recall without query returns both inserted learnings', async () => {
    const { learn, recall } = await import('./learn.js');
    learn({ category: 'pattern', content: 'first pattern entry' });
    learn({ category: 'insight', content: 'second insight entry' });
    const result = recall({});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ content: string }> };
      expect(data.results.length).toBeGreaterThanOrEqual(2);
      // Both entries should be present. We don't assert on order because
      // the schema stores timestamps at second resolution — two inserts in
      // the same second have an undefined relative order.
      const contents = data.results.map((r) => r.content);
      expect(contents).toContain('first pattern entry');
      expect(contents).toContain('second insight entry');
    }
  });

  it('recall with query uses FTS5 and finds the match', async () => {
    const { learn, recall } = await import('./learn.js');
    learn({ category: 'pattern', content: 'the bluebird of happiness sings at dawn' });
    learn({ category: 'pattern', content: 'completely unrelated thing about ducks' });
    const result = recall({ query: 'bluebird' });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ content: string }> };
      expect(data.results.length).toBe(1);
      expect(data.results[0]?.content).toContain('bluebird');
    }
  });

  it('unified search finds hits across learnings and decisions', async () => {
    const { learn } = await import('./learn.js');
    const { decide } = await import('./decide.js');
    const { search } = await import('./search.js');
    learn({ category: 'pattern', content: 'pineapple pizza is controversial' });
    decide({
      title: 'pineapple as topping',
      decision: 'yes to pineapple pizza',
      reasoning: 'enzymes balance the cheese fat',
    });
    const result = search({ query: 'pineapple' });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ type: string }> };
      const types = data.results.map((r) => r.type);
      expect(types).toContain('learning');
      expect(types).toContain('decision');
    }
  });
});

describe('tool registry', () => {
  it('exports exactly 13 tools with valid JSON Schema for each', async () => {
    const { TOOLS, toMcpToolList } = await import('./registry.js');
    expect(TOOLS.length).toBe(13);
    const listed = toMcpToolList();
    expect(listed.length).toBe(13);
    for (const t of listed) {
      expect(t.name).toMatch(/^memory_/);
      expect(typeof t.description).toBe('string');
      expect((t.inputSchema as Record<string, unknown>).type).toBe('object');
    }
  });

  it('memory_learn input schema includes required category and content', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const learn = toMcpToolList().find((t) => t.name === 'memory_learn');
    expect(learn).toBeDefined();
    const schema = learn!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain('category');
    expect(schema.required).toContain('content');
    expect(schema.properties.category).toBeDefined();
  });
});
