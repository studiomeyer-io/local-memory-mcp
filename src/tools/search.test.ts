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
    learn({ category: 'pattern', content: 'quicksort partitions around a pivot' });
    const result = search({ query: 'quicksort' });
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
    decide({ title: 'Rust for the hot path', decision: 'yes', reasoning: 'bench shows 4x' });
    const result = search({ query: 'Rust' });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string; title: string }> };
      expect(d.results.some((r) => r.type === 'decision' && r.title === 'Rust for the hot path')).toBe(true);
    }
  });

  it('finds an entity via its name trigger', async () => {
    const { entityCreate } = await import('./entity.js');
    const { search } = await import('./search.js');
    entityCreate({ name: 'Apollo', entityType: 'project', summary: 'moon mission' });
    const result = search({ query: 'Apollo' });
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
    entityObserve({
      entityId: (created.data as { id: string }).id,
      content: 'detected a memory leak in the auth module',
    });
    const result = search({ query: 'leak' });
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
    learn({ category: 'pattern', content: 'tomato soup recipe' });
    decide({ title: 'tomato bisque policy', decision: 'allow', reasoning: 'better than nothing' });
    const result = search({ query: 'tomato', types: ['decision'] });
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
    learn({ category: 'pattern', content: 'orange is a fruit' });
    decide({ title: 'orange juice', decision: 'yes', reasoning: 'vitamin c' });
    entityCreate({ name: 'Orange', entityType: 'concept' });
    const result = search({ query: 'orange', types: ['learning', 'decision'] });
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

    const alive = learn({ category: 'pattern', content: 'banana bread is moist' });
    const dead = learn({ category: 'pattern', content: 'banana smoothie is cold' });
    if (dead.success) {
      getDb().prepare('UPDATE learnings SET archived = 1 WHERE id = ?').run((dead.data as { id: string }).id);
    }

    const result = search({ query: 'banana' });
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
      const r = learn({ category: 'pattern', content: `banana fact ${i}` });
      if (r.success) ids.push((r.data as { id: string }).id);
    }
    // Archive the first 3 so they'd otherwise dominate the top rank slots.
    const db = getDb();
    for (let i = 0; i < 3; i++) {
      db.prepare('UPDATE learnings SET archived = 1 WHERE id = ?').run(ids[i]);
    }

    const result = search({ query: 'banana', limit: 2 });
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
    decide({ title: 'koala habitat', decision: 'preserve', reasoning: 'trees' });
    const result = search({ query: 'koala' });
    if (result.success) {
      const d = result.data as { results: Array<{ type: string }> };
      expect(d.results.some((r) => r.type === 'decision')).toBe(true);
    }
  });

  it('returns an empty result set (not an error) for a zero-match query', async () => {
    const { search } = await import('./search.js');
    const result = search({ query: 'definitelynotpresentxyzabc' });
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
      learn({ category: 'pattern', content: `grape entry number ${i}` });
    }
    const result = search({ query: 'grape' });
    if (result.success) {
      const d = result.data as { results: unknown[] };
      expect(d.results.length).toBe(20);
    }
  });

  it('honours a custom limit', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    for (let i = 0; i < 10; i++) {
      learn({ category: 'pattern', content: `melon entry ${i}` });
    }
    const result = search({ query: 'melon', limit: 3 });
    if (result.success) {
      const d = result.data as { results: unknown[] };
      expect(d.results.length).toBe(3);
    }
  });

  it('handles multi-word queries via OR-of-quoted-tokens (finds any match)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    learn({ category: 'pattern', content: 'red panda lives in bamboo forests' });
    learn({ category: 'pattern', content: 'the silver fox is quick and quiet' });
    const result = search({ query: 'panda fox' });
    if (result.success) {
      const d = result.data as { results: Array<{ body: string }> };
      // Both should match because each contains one of the tokens.
      expect(d.results.length).toBe(2);
    }
  });

  it('gracefully handles FTS5-hostile characters in the query (never throws)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    learn({ category: 'pattern', content: 'parens are (sometimes) meaningful' });
    // Parens/quotes/operators go through escapeFtsQuery — the call must not throw.
    expect(() => search({ query: '(parens)' })).not.toThrow();
    expect(() => search({ query: '"quoted"' })).not.toThrow();
    expect(() => search({ query: 'a | b' })).not.toThrow();
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
});
