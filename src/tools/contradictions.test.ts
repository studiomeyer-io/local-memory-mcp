/**
 * Tests for the P3.2 contradiction scanner.
 *
 * Uses MEMORY_EMBED_MOCK=1 (set by the `npm test` script) so each insert
 * produces a deterministic token-hash embedding. The mock cosine is
 * meaningful for "shared-token" comparisons: two strings that share most
 * tokens will land at high cosine similarity, two that share none land
 * near zero. The scanner's negation/confidence heuristics live above the
 * embedding layer so they're identical between the real model and the mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-contra-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory_contradictions', () => {
  it('returns VECTOR_DISABLED when sqlite-vec is not loaded', async () => {
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (isVectorEnabled()) {
      // This environment has vec loaded, so we can't simulate the off-path
      // here. The vec.test.ts file covers the disabled path explicitly.
      return;
    }
    const result = contradictions({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('VECTOR_DISABLED');
    }
  });

  it('flags a pair with negation_diff and reports both observations', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'NegCase', entityType: 'person' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;

    // Two observations sharing most tokens — the mock embedding pushes their
    // cosine very high — but one carries a negation marker.
    await entityObserve({ entityId: eid, content: 'matthias prefers postgres for analytical work' });
    await entityObserve({ entityId: eid, content: 'matthias no longer prefers postgres for analytical work' });

    const result = contradictions({ entityId: eid, minCosine: 0.5 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as {
        pairs: Array<{ reasons: string[]; cosineSim: number; older: { content: string }; newer: { content: string } }>;
        count: number;
      };
      expect(d.count).toBeGreaterThanOrEqual(1);
      const top = d.pairs[0]!;
      expect(top.reasons).toContain('negation_diff');
      expect(top.cosineSim).toBeGreaterThan(0.5);
      // Older / newer by valid_from — both must be present.
      expect(typeof top.older.content).toBe('string');
      expect(typeof top.newer.content).toBe('string');
    }
  });

  it('flags a pair with confidence_drift even when no negation is present', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'ConfCase', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;

    // Same surface content, very different confidence. No negation markers.
    await entityObserve({ entityId: eid, content: 'the cache layer is redis', confidence: 0.95 });
    await entityObserve({ entityId: eid, content: 'the cache layer is redis', confidence: 0.30 });

    const result = contradictions({ entityId: eid, minCosine: 0.6, minConfidenceDrift: 0.3 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as {
        pairs: Array<{ reasons: string[]; confidenceDrift: number }>;
      };
      expect(d.pairs.length).toBeGreaterThanOrEqual(1);
      expect(d.pairs[0]!.reasons).toContain('confidence_drift');
      expect(d.pairs[0]!.confidenceDrift).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('returns empty pairs when neither negation nor confidence drift is present', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'CleanCase', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;

    // Two observations with similar content, same confidence, no negation.
    // The scanner should NOT flag them as contradictions even though their
    // cosine is high (they're duplicates, not contradictions).
    await entityObserve({ entityId: eid, content: 'the database uses postgres' });
    await entityObserve({ entityId: eid, content: 'the database uses postgres for storage' });

    const result = contradictions({ entityId: eid, minCosine: 0.5 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { pairs: unknown[] };
      expect(d.pairs.length).toBe(0);
    }
  });

  it('honours the entityId scope and ignores observations on other entities', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const a = entityCreate({ name: 'ScopeA', entityType: 'person' });
    const b = entityCreate({ name: 'ScopeB', entityType: 'person' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const aid = (a.data as { id: string }).id;
    const bid = (b.data as { id: string }).id;

    // Plant a contradiction on entity A.
    await entityObserve({ entityId: aid, content: 'works at acme' });
    await entityObserve({ entityId: aid, content: 'no longer works at acme' });
    // Plant a contradiction on entity B too.
    await entityObserve({ entityId: bid, content: 'lives in palma' });
    await entityObserve({ entityId: bid, content: 'no longer lives in palma' });

    // Scope to A → only one contradiction returned, and it's on A.
    const scoped = contradictions({ entityId: aid, minCosine: 0.5 });
    expect(scoped.success).toBe(true);
    if (scoped.success) {
      const d = scoped.data as {
        pairs: Array<{ entityId: string }>;
        scope: string;
      };
      expect(d.scope).toBe(`entity:${aid}`);
      for (const p of d.pairs) {
        expect(p.entityId).toBe(aid);
      }
      expect(d.pairs.length).toBeGreaterThanOrEqual(1);
    }

    // Global scan → finds both.
    const global = contradictions({ minCosine: 0.5 });
    if (global.success) {
      const d = global.data as { pairs: Array<{ entityId: string }>; scope: string };
      expect(d.scope).toBe('all');
      const ids = new Set(d.pairs.map((p) => p.entityId));
      expect(ids.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('resolves entityName+entityType to a scoped scan', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'NamedScope', entityType: 'project' });
    if (!created.success) throw new Error('setup failed');
    await entityObserve({ entityName: 'NamedScope', entityType: 'project', content: 'status is green' });
    await entityObserve({ entityName: 'NamedScope', entityType: 'project', content: 'status is no longer green' });

    const result = contradictions({ entityName: 'NamedScope', entityType: 'project', minCosine: 0.5 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { pairs: unknown[]; scope: string };
      expect(d.scope).toMatch(/^entity:/);
      expect(d.pairs.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns NOT_FOUND when entityId references a missing entity', async () => {
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const result = contradictions({ entityId: 'no-such-entity' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  it('respects the limit parameter', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'LimitCase', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    // Seed 4 negation pairs by varying suffix tokens.
    for (let i = 0; i < 4; i++) {
      await entityObserve({ entityId: eid, content: `claim about subject ${i} is true` });
      await entityObserve({ entityId: eid, content: `claim about subject ${i} is not true` });
    }

    const result = contradictions({ entityId: eid, minCosine: 0.4, limit: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { pairs: unknown[]; count: number };
      expect(d.pairs.length).toBeLessThanOrEqual(2);
      expect(d.count).toBe(d.pairs.length);
    }
  });

  // ─── R1 Analyst — missing test coverage gaps ───────

  it('returns an empty pairs list for an entity with zero observations', async () => {
    const { entityCreate } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    // Entity exists but no observations attached → no pairs possible. The
    // SQL self-join over entity_observations is empty for this entity, so
    // candidates list is empty. Verify the response shape is well-formed
    // (no NaN, no undefined, no crash).
    const e = entityCreate({ name: 'EmptyObs', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const result = contradictions({ entityId: eid });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { pairs: unknown[]; count: number; scope: string };
      expect(d.pairs).toEqual([]);
      expect(d.count).toBe(0);
      expect(d.scope).toBe(`entity:${eid}`);
    }
  });

  it('silently excludes observations without an embedding row (pre-v2 legacy data)', async () => {
    // Observations created before v2.0.0 (or under MEMORY_EMBED_DISABLED=1)
    // have no `embeddings` row. The scanner's INNER JOIN to `embeddings`
    // drops those rows automatically. We don't crash, we don't double-count.
    // Verifying the shape gives users with mixed-vintage data confidence
    // the tool degrades gracefully.
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'MixedVintage', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;

    // One observation with embedding (the auto-embed-on-insert path).
    const live = await entityObserve({ entityId: eid, content: 'live observation with embedding' });
    if (!live.success) throw new Error('observe failed');
    const liveId = (live.data as { observationId: string }).observationId;

    // One observation whose embedding we DELETE to simulate pre-v2 data.
    const pre = await entityObserve({ entityId: eid, content: 'legacy observation no embedding' });
    if (!pre.success) throw new Error('observe failed');
    const preId = (pre.data as { observationId: string }).observationId;
    getDb().prepare('DELETE FROM embeddings WHERE content_id = ?').run(preId);

    // Sanity check: the live obs still has its embedding, the legacy one doesn't.
    const liveCnt = (getDb()
      .prepare('SELECT COUNT(*) AS c FROM embeddings WHERE content_id = ?')
      .get(liveId) as { c: number }).c;
    const preCnt = (getDb()
      .prepare('SELECT COUNT(*) AS c FROM embeddings WHERE content_id = ?')
      .get(preId) as { c: number }).c;
    expect(liveCnt).toBe(1);
    expect(preCnt).toBe(0);

    // The scanner must not crash and must not pair the legacy one.
    const result = contradictions({ entityId: eid, minCosine: 0.1 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { pairs: unknown[]; count: number };
      // No pairs because the legacy obs is silently dropped by the JOIN.
      expect(d.pairs.length).toBe(0);
      expect(d.count).toBe(0);
    }
  });

  it('ignores observations that have already been superseded (valid_to set)', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('./../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'TombstoneCase', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    await entityObserve({ entityId: eid, content: 'flag X is on' });
    const second = await entityObserve({ entityId: eid, content: 'flag X is not on' });
    if (!second.success) throw new Error('observe failed');

    // Manually retire the first observation to simulate a prior resolve.
    getDb().prepare("UPDATE entity_observations SET valid_to = datetime('now') WHERE content = ?").run('flag X is on');

    const result = contradictions({ entityId: eid, minCosine: 0.3 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { pairs: unknown[] };
      // The retired observation must not pair with the live one anymore.
      expect(d.pairs.length).toBe(0);
    }
  });
});
