/**
 * Tests for the unified FTS5 search surface.
 *
 * Behaviour under test:
 *   - Finds hits across learning / decision / entity / observation.
 *   - Filters results by content_type when `types` is passed.
 *   - Archived learnings are filtered at the SQL join level (v1.0.6 fix) so
 *     LIMIT applies to the post-filter set.
 *   - Returns a well-formed empty result (not an error) for a no-hit query.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-search-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('unified search', () => {
  it('finds a learning by its content', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'quicksort partitions around a pivot' });
    const result = await search({ query: 'quicksort' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: Array<{ type: string; body: string }> };
      expect(d.results.length).toBe(1);
      expect(d.results[0]?.type).toBe('learning');
      expect(d.results[0]?.body).toContain('quicksort');
    }
  });

  it('finds a decision by its title', async () => {
    const { decide } = await import('./decide.js');
    const { search } = await import('./search.js');
    await decide({ title: 'Rust for the hot path', decision: 'yes', reasoning: 'bench shows 4x' });
    const result = await search({ query: 'Rust' });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string; title: string }> };
      expect(d.results.some((r) => r.type === 'decision' && r.title === 'Rust for the hot path')).toBe(true);
    }
  });

  it('finds an entity via its name trigger', async () => {
    const { entityCreate } = await import('./entity.js');
    const { search } = await import('./search.js');
    entityCreate({ name: 'Apollo', entityType: 'project', summary: 'moon mission' });
    const result = await search({ query: 'Apollo' });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string }> };
      const types = d.results.map((r) => r.type);
      expect(types).toContain('entity');
    }
  });

  it('finds an observation via its content trigger', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { search } = await import('./search.js');
    const created = entityCreate({ name: 'Server', entityType: 'infrastructure' });
    if (!created.success) throw new Error('setup failed');
    await entityObserve({
      entityId: (created.data as { id: string }).id,
      content: 'detected a memory leak in the auth module',
    });
    const result = await search({ query: 'leak' });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string; body: string }> };
      const obsHit = d.results.find((r) => r.type === 'observation');
      expect(obsHit).toBeDefined();
      expect(obsHit?.body).toContain('leak');
    }
  });

  it('filters by content type when `types` is passed', async () => {
    const { learn } = await import('./learn.js');
    const { decide } = await import('./decide.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'tomato soup recipe' });
    await decide({ title: 'tomato bisque policy', decision: 'allow', reasoning: 'better than nothing' });
    const result = await search({ query: 'tomato', types: ['decision'] });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string }> };
      expect(d.results.length).toBeGreaterThan(0);
      expect(d.results.every((r) => r.type === 'decision')).toBe(true);
    }
  });

  it('supports multiple type filters at once', async () => {
    const { learn } = await import('./learn.js');
    const { decide } = await import('./decide.js');
    const { entityCreate } = await import('./entity.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'orange is a fruit' });
    await decide({ title: 'orange juice', decision: 'yes', reasoning: 'vitamin c' });
    entityCreate({ name: 'Orange', entityType: 'concept' });
    const result = await search({ query: 'orange', types: ['learning', 'decision'] });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string }> };
      expect(d.results.every((r) => ['learning', 'decision'].includes(r.type))).toBe(true);
      // Entity hits are excluded by the filter.
      expect(d.results.every((r) => r.type !== 'entity')).toBe(true);
    }
  });

  it('excludes archived learnings from results (v1.0.6 regression guard)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');

    const alive = await learn({ category: 'pattern', content: 'banana bread is moist' });
    const dead = await learn({ category: 'pattern', content: 'banana smoothie is cold' });
    if (dead.success) {
      getDb().prepare('UPDATE learnings SET archived = 1 WHERE id = ?').run((dead.data as { id: string }).id);
    }

    const result = await search({ query: 'banana' });
    if (result.success) {
      const d = result.data as { results: Array<{ id: string; body: string }> };
      const aliveId = (alive.data as { id: string }).id;
      const deadId = (dead.data as { id: string }).id;
      const hitIds = d.results.map((r) => r.id);
      expect(hitIds).toContain(aliveId);
      expect(hitIds).not.toContain(deadId);
    }
  });

  it('LIMIT applies to the post-archive-filter set (v1.0.6 bug fix)', async () => {
    // Previously the filter ran in memory after LIMIT, so a single archived row
    // in the top-N meant you got N-1 rows back. With the SQL-level filter,
    // LIMIT=2 must always yield up to 2 unarchived hits when they exist.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await learn({ category: 'pattern', content: `banana fact ${i}` });
      if (r.success) ids.push((r.data as { id: string }).id);
    }
    // Archive the first 3 so they'd otherwise dominate the top rank slots.
    const db = getDb();
    for (let i = 0; i < 3; i++) {
      db.prepare('UPDATE learnings SET archived = 1 WHERE id = ?').run(ids[i]);
    }

    const result = await search({ query: 'banana', limit: 2 });
    if (result.success) {
      const d = result.data as { results: Array<{ id: string }>; count: number };
      expect(d.count).toBe(2);
      // No archived row sneaks in.
      expect(d.results.map((r) => r.id).every((id) => !ids.slice(0, 3).includes(id))).toBe(true);
    }
  });

  it('archive filter does not affect decision / entity / observation hits', async () => {
    // Decisions have no `archived` column, so they must never be filtered out.
    const { decide } = await import('./decide.js');
    const { search } = await import('./search.js');
    await decide({ title: 'koala habitat', decision: 'preserve', reasoning: 'trees' });
    const result = await search({ query: 'koala' });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string }> };
      expect(d.results.some((r) => r.type === 'decision')).toBe(true);
    }
  });

  it('returns an empty result set (not an error) for a zero-match query', async () => {
    const { search } = await import('./search.js');
    const result = await search({ query: 'definitelynotpresentxyzabc' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: unknown[]; count: number };
      expect(d.results.length).toBe(0);
      expect(d.count).toBe(0);
    }
  });

  it('honours the default limit of 20 when none is passed', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    for (let i = 0; i < 25; i++) {
      await learn({ category: 'pattern', content: `grape entry number ${i}` });
    }
    const result = await search({ query: 'grape' });
    if (result.success) {
      const d = result.data as { results: unknown[] };
      expect(d.results.length).toBe(20);
    }
  });

  it('honours a custom limit', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    for (let i = 0; i < 10; i++) {
      await learn({ category: 'pattern', content: `melon entry ${i}` });
    }
    const result = await search({ query: 'melon', limit: 3 });
    if (result.success) {
      const d = result.data as { results: unknown[] };
      expect(d.results.length).toBe(3);
    }
  });

  it('handles multi-word queries via OR-of-quoted-tokens (finds any match)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'red panda lives in bamboo forests' });
    await learn({ category: 'pattern', content: 'the silver fox is quick and quiet' });
    const result = await search({ query: 'panda fox' });
    if (result.success) {
      const d = result.data as { results: Array<{ body: string }> };
      // Both should match because each contains one of the tokens.
      expect(d.results.length).toBe(2);
    }
  });

  it('gracefully handles FTS5-hostile characters in the query (never throws)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'parens are (sometimes) meaningful' });
    // Parens/quotes/operators go through escapeFtsQuery — the call must not reject.
    await expect(search({ query: '(parens)' })).resolves.toBeDefined();
    await expect(search({ query: '"quoted"' })).resolves.toBeDefined();
    await expect(search({ query: 'a | b' })).resolves.toBeDefined();
  });
});

describe('search schema', () => {
  it('rejects empty query', async () => {
    const { searchSchema } = await import('./search.js');
    expect(searchSchema.safeParse({ query: '' }).success).toBe(false);
  });

  it('rejects a `types` entry outside the enum', async () => {
    const { searchSchema } = await import('./search.js');
    expect(searchSchema.safeParse({ query: 'ok', types: ['invalid-kind'] }).success).toBe(false);
  });

  it('rejects a limit outside the 1..100 range', async () => {
    const { searchSchema } = await import('./search.js');
    expect(searchSchema.safeParse({ query: 'ok', limit: 0 }).success).toBe(false);
    expect(searchSchema.safeParse({ query: 'ok', limit: 101 }).success).toBe(false);
    expect(searchSchema.safeParse({ query: 'ok', limit: 50 }).success).toBe(true);
  });

  it('accepts mode: fts | vector | hybrid', async () => {
    const { searchSchema } = await import('./search.js');
    expect(searchSchema.safeParse({ query: 'ok', mode: 'fts' }).success).toBe(true);
    expect(searchSchema.safeParse({ query: 'ok', mode: 'vector' }).success).toBe(true);
    expect(searchSchema.safeParse({ query: 'ok', mode: 'hybrid' }).success).toBe(true);
  });

  it('rejects an unknown mode value', async () => {
    const { searchSchema } = await import('./search.js');
    expect(searchSchema.safeParse({ query: 'ok', mode: 'wrong' }).success).toBe(false);
  });
});

// ─── Hybrid search (v2.0.0+) ──────────────────────────────
// These tests verify the new modes, the RRF fusion, and the graceful
// downgrade contract when sqlite-vec isn't loaded. They all run under
// MEMORY_EMBED_MOCK=1 (set in npm test) so the embedding pipeline is
// deterministic and fast.

describe('search modes (v2.0.0+ hybrid retrieval)', () => {
  it('defaults to hybrid mode when nothing is passed', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    await learn({ category: 'pattern', content: 'mediterranean diet emphasises olive oil' });
    const r = await search({ query: 'mediterranean' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { mode: string };
      // Defaults to hybrid if vec is loaded, otherwise transparently FTS.
      expect(d.mode).toBe(isVectorEnabled() ? 'hybrid' : 'fts');
    }
  });

  it('respects explicit mode: fts', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'palma de mallorca harbour at sunset' });
    const r = await search({ query: 'palma', mode: 'fts' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { mode: string; results: Array<{ body: string }> };
      expect(d.mode).toBe('fts');
      expect(d.results[0]?.body).toContain('palma');
    }
  });

  it('vector mode falls back to fts when sqlite-vec isn\'t loaded', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    await learn({ category: 'insight', content: 'a fox is faster than a turtle' });
    const r = await search({ query: 'fox', mode: 'vector' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { mode: string };
      // If vec is on the runner: 'vector'. If not: silent downgrade to 'fts'.
      expect(['vector', 'fts']).toContain(d.mode);
      if (!isVectorEnabled()) expect(d.mode).toBe('fts');
    }
  });

  it('hybrid finds a row that only the vector ranker would catch', async () => {
    // The query "fruit" never appears in the stored text, so FTS5 misses.
    // The mock embedder maps "fruit" tokens to the same buckets as the
    // word "fruit" inside the stored content, so cosine should still find
    // the row when vec is enabled.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    await learn({ category: 'pattern', content: 'apple banana cherry fruit basket' });
    if (!isVectorEnabled()) return; // No-op on platforms without vec.

    const r = await search({ query: 'fruit basket', mode: 'hybrid' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ id: string; body: string }>; mode: string };
      expect(d.mode).toBe('hybrid');
      expect(d.results.length).toBeGreaterThan(0);
      expect(d.results.some((row) => row.body.includes('fruit'))).toBe(true);
    }
  });

  it('hybrid mode returns higher rank (RRF score) for rows both rankers agree on', async () => {
    // The strongest signal in RRF is the row that wins both BM25 and cosine.
    // We seed three rows with varying token overlap to that query and check
    // the consensus winner comes out on top.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    await learn({ category: 'pattern', content: 'sqlite vector search with cosine distance' });
    await learn({ category: 'pattern', content: 'completely unrelated text about gardening' });
    await learn({ category: 'pattern', content: 'distance between rows in a database' });

    const r = await search({ query: 'sqlite vector', mode: 'hybrid', limit: 3 });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ body: string; rank: number }> };
      expect(d.results.length).toBeGreaterThan(0);
      // The first hit must mention both query tokens (sqlite + vector).
      expect(d.results[0]?.body).toMatch(/sqlite/);
      expect(d.results[0]?.body).toMatch(/vector/);
      // RRF score must be a positive number (sum of 1/(60+rank) contributions).
      expect(d.results[0]?.rank).toBeGreaterThan(0);
    }
  });

  it('hybrid still applies the archived-learnings filter', async () => {
    // Hybrid path uses the post-filter for the vector leg and the SQL-level
    // archived guard for the FTS leg. Both must drop the archived row.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const alive = await learn({ category: 'pattern', content: 'archive guard live one' });
    const dead = await learn({ category: 'pattern', content: 'archive guard buried one' });
    if (dead.success) {
      getDb()
        .prepare('UPDATE learnings SET archived = 1 WHERE id = ?')
        .run((dead.data as { id: string }).id);
    }

    const r = await search({ query: 'archive guard', mode: 'hybrid' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ id: string }> };
      const ids = d.results.map((row) => row.id);
      expect(ids).toContain((alive.data as { id: string }).id);
      expect(ids).not.toContain((dead.data as { id: string }).id);
    }
  });

  it('hybrid honours the `types` filter on both legs', async () => {
    const { learn } = await import('./learn.js');
    const { decide } = await import('./decide.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    await learn({ category: 'pattern', content: 'maracuja smoothie recipe' });
    await decide({ title: 'maracuja import', decision: 'buy from brazil', reasoning: 'cheaper' });

    const r = await search({ query: 'maracuja', mode: 'hybrid', types: ['decision'] });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ type: string }> };
      expect(d.results.length).toBeGreaterThan(0);
      expect(d.results.every((row) => row.type === 'decision')).toBe(true);
    }
  });

  it('vector mode returns count >= 0 even when no document matches', async () => {
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;
    const r = await search({ query: 'nothingstoredherexyz', mode: 'vector' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { count: number };
      expect(d.count).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports the effective mode in the response payload', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'mode echo back test' });
    const r = await search({ query: 'mode', mode: 'fts' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { mode: string };
      expect(d.mode).toBe('fts');
    }
  });

  it('F5 fix: returns a notice + requestedMode when vector mode downgrades to FTS', async () => {
    // When the user explicitly asks for vector mode but the runtime can't
    // produce a query vector (mock is fine, but force the downgrade by
    // disabling embeddings via the env switch), the response must carry
    // (a) data.mode === 'fts' (the path that ran), (b) data.requestedMode
    // === 'vector' (what the user asked for), and (c) data.notice
    // describing why. Without this contract, benchmark agents that test
    // semantic recall could be measuring BM25 instead and never know.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { _resetForTests } = await import('../lib/embed.js');
    await learn({ category: 'pattern', content: 'silent downgrade trap' });

    process.env.MEMORY_EMBED_DISABLED = '1';
    _resetForTests();
    try {
      const r = await search({ query: 'silent downgrade trap', mode: 'vector' });
      expect(r.success).toBe(true);
      if (r.success) {
        const d = r.data as { mode: string; requestedMode: string; notice?: string };
        expect(d.mode).toBe('fts');
        expect(d.requestedMode).toBe('vector');
        expect(d.notice).toBeDefined();
        expect(d.notice).toMatch(/vector/i);
      }
    } finally {
      delete process.env.MEMORY_EMBED_DISABLED;
      process.env.MEMORY_EMBED_MOCK = '1';
      _resetForTests();
    }
  });

  it('F5 fix: no notice field when the requested mode actually runs', async () => {
    // Inverse guard: when the requested mode is available and runs, there
    // should be no notice field (so machine consumers can use its presence
    // as the signal that a downgrade happened).
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'clean run no notice' });
    const r = await search({ query: 'clean', mode: 'fts' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { mode: string; notice?: string };
      expect(d.mode).toBe('fts');
      expect(d.notice).toBeUndefined();
    }
  });
});
