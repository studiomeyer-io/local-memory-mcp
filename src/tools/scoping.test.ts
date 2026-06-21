/**
 * Tests for v2.3.0 project/tags scoping on memory_search and memory_recall.
 *
 * The two main retrieval tools previously had no way to scope to one project,
 * even though insights/reflect accepted `project`. These tests prove:
 *   - search scoped to a project returns only that project's rows.
 *   - search scoped by tags returns only rows carrying one of the tags.
 *   - recall (FTS-only) honours the same project/tags filters.
 *   - the absent-filter behaviour is unchanged (regression guard).
 *
 * Runs under MEMORY_EMBED_MOCK=1 (set by `npm test`) so the embedding pipeline
 * is deterministic. Scoping is applied in every mode; we exercise it through the
 * default hybrid path and an explicit fts path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-scoping-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory_search — project scoping', () => {
  it('returns only rows from the requested project', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'kafka topic partition strategy', project: 'alpha' });
    await learn({ category: 'pattern', content: 'kafka consumer group rebalancing', project: 'beta' });

    const r = await search({ query: 'kafka', project: 'alpha' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ body: string }>; count: number; project?: string };
      expect(d.count).toBe(1);
      expect(d.results[0]?.body).toContain('partition');
      expect(d.project).toBe('alpha');
    }
  });

  it('scopes decisions by project too', async () => {
    const { decide } = await import('./decide.js');
    const { search } = await import('./search.js');
    await decide({ title: 'pinot for olap', decision: 'adopt', reasoning: 'fast', project: 'alpha' });
    await decide({ title: 'pinot rollout plan', decision: 'phase it', reasoning: 'risk', project: 'beta' });

    const r = await search({ query: 'pinot', project: 'beta', mode: 'fts' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ title: string }> };
      expect(d.results.length).toBe(1);
      expect(d.results[0]?.title).toBe('pinot rollout plan');
    }
  });

  it('excludes entity/observation rows when a project filter is active (they have no project)', async () => {
    const { learn } = await import('./learn.js');
    const { entityCreate } = await import('./entity.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'orion telemetry pipeline', project: 'alpha' });
    entityCreate({ name: 'Orion', entityType: 'project', summary: 'orion telemetry' });

    // Unscoped: both the learning and the entity match "orion".
    const unscoped = await search({ query: 'orion', mode: 'fts' });
    if (unscoped.success) {
      const d = unscoped.data as { results: Array<{ type: string }> };
      expect(d.results.some((x) => x.type === 'entity')).toBe(true);
    }

    // Scoped to alpha: only the learning survives — the entity has no project.
    const scoped = await search({ query: 'orion', project: 'alpha', mode: 'fts' });
    if (scoped.success) {
      const d = scoped.data as { results: Array<{ type: string }> };
      expect(d.results.length).toBeGreaterThan(0);
      expect(d.results.every((x) => x.type === 'learning')).toBe(true);
    }
  });

  it('returns an empty set for a project with no matching rows (not an error)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'redis pub sub fanout', project: 'alpha' });
    const r = await search({ query: 'redis', project: 'nonexistent' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { count: number };
      expect(d.count).toBe(0);
    }
  });
});

describe('memory_search — tags scoping', () => {
  it('returns only rows carrying one of the requested tags', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'grafana dashboard layout', tags: ['observability', 'ui'] });
    await learn({ category: 'pattern', content: 'grafana alerting rules', tags: ['oncall'] });

    const r = await search({ query: 'grafana', tags: ['observability'] });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ body: string }>; count: number; tags?: string[] };
      expect(d.count).toBe(1);
      expect(d.results[0]?.body).toContain('dashboard');
      expect(d.tags).toEqual(['observability']);
    }
  });

  it('matches ANY of multiple tags (OR semantics)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'nebula one', tags: ['x'] });
    await learn({ category: 'pattern', content: 'nebula two', tags: ['y'] });
    await learn({ category: 'pattern', content: 'nebula three', tags: ['z'] });

    const r = await search({ query: 'nebula', tags: ['x', 'y'], mode: 'fts' });
    if (r.success) {
      const d = r.data as { results: Array<{ body: string }>; count: number };
      expect(d.count).toBe(2);
      const bodies = d.results.map((x) => x.body).join(' ');
      expect(bodies).toContain('one');
      expect(bodies).toContain('two');
      expect(bodies).not.toContain('three');
    }
  });

  it('exact tag membership — a tag "ui" does not match a tag "build" (no substring collisions)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'guidance one', tags: ['guide'] });
    // "gui" must NOT match the stored "guide" tag — json_each is exact.
    const r = await search({ query: 'guidance', tags: ['gui'], mode: 'fts' });
    if (r.success) {
      const d = r.data as { count: number };
      expect(d.count).toBe(0);
    }
  });

  it('combines project AND tags (both must hold)', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'saturn alpha tagged', project: 'alpha', tags: ['keep'] });
    await learn({ category: 'pattern', content: 'saturn alpha untagged', project: 'alpha', tags: ['drop'] });
    await learn({ category: 'pattern', content: 'saturn beta tagged', project: 'beta', tags: ['keep'] });

    const r = await search({ query: 'saturn', project: 'alpha', tags: ['keep'], mode: 'fts' });
    if (r.success) {
      const d = r.data as { results: Array<{ body: string }>; count: number };
      expect(d.count).toBe(1);
      expect(d.results[0]?.body).toContain('alpha tagged');
    }
  });
});

describe('memory_search — absent filter = unchanged behaviour (regression guard)', () => {
  it('returns all matching rows when neither project nor tags is passed', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'vega entry one', project: 'alpha' });
    await learn({ category: 'pattern', content: 'vega entry two', project: 'beta' });
    await learn({ category: 'pattern', content: 'vega entry three' });

    const r = await search({ query: 'vega', mode: 'fts' });
    if (r.success) {
      const d = r.data as { count: number; project?: string; tags?: string[] };
      expect(d.count).toBe(3);
      // No echo of project/tags when not requested.
      expect(d.project).toBeUndefined();
      expect(d.tags).toBeUndefined();
    }
  });
});

describe('memory_recall — project/tags scoping (FTS-only)', () => {
  it('scopes recall results by project', async () => {
    const { learn, recall } = await import('./learn.js');
    await learn({ category: 'pattern', content: 'lyra ingestion job', project: 'alpha' });
    await learn({ category: 'pattern', content: 'lyra ingestion retry', project: 'beta' });

    const r = recall({ query: 'lyra', project: 'alpha' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ content: string; project: string }>; count: number };
      expect(d.count).toBe(1);
      expect(d.results[0]?.project).toBe('alpha');
    }
  });

  it('scopes recall results by tags', async () => {
    const { learn, recall } = await import('./learn.js');
    await learn({ category: 'pattern', content: 'cetus deploy step', tags: ['ops'] });
    await learn({ category: 'pattern', content: 'cetus deploy notes', tags: ['docs'] });

    const r = recall({ query: 'cetus', tags: ['ops'] });
    if (r.success) {
      const d = r.data as { results: Array<{ content: string }>; count: number };
      expect(d.count).toBe(1);
      expect(d.results[0]?.content).toContain('step');
    }
  });

  it('scopes the no-query most-recent path by project', async () => {
    const { learn, recall } = await import('./learn.js');
    await learn({ category: 'pattern', content: 'draco fact a', project: 'alpha' });
    await learn({ category: 'pattern', content: 'draco fact b', project: 'beta' });

    const r = recall({ project: 'beta' });
    if (r.success) {
      const d = r.data as { results: Array<{ project: string }>; count: number };
      expect(d.count).toBe(1);
      expect(d.results.every((x) => x.project === 'beta')).toBe(true);
    }
  });

  it('absent filter returns all live learnings (regression guard)', async () => {
    const { learn, recall } = await import('./learn.js');
    await learn({ category: 'pattern', content: 'hydra one', project: 'alpha' });
    await learn({ category: 'pattern', content: 'hydra two' });
    const r = recall({ query: 'hydra' });
    if (r.success) {
      const d = r.data as { count: number };
      expect(d.count).toBe(2);
    }
  });
});

describe('schema — project/tags validation', () => {
  it('search schema accepts project + tags', async () => {
    const { searchSchema } = await import('./search.js');
    expect(searchSchema.safeParse({ query: 'x', project: 'p', tags: ['a', 'b'] }).success).toBe(true);
  });
  it('search schema rejects an empty tags array', async () => {
    const { searchSchema } = await import('./search.js');
    expect(searchSchema.safeParse({ query: 'x', tags: [] }).success).toBe(false);
  });
  it('recall schema accepts project + tags', async () => {
    const { recallSchema } = await import('./learn.js');
    expect(recallSchema.safeParse({ query: 'x', project: 'p', tags: ['a'] }).success).toBe(true);
  });
});
