/**
 * Tests for the v2.3.0 per-entity observation cap on the contradiction scanner.
 *
 * The intra-entity self-join is O(N^2): one entity with thousands of
 * observations is a quadratic cliff (millions of vec_distance_cosine calls).
 * v2.3.0 caps the candidate set to `maxObservationsPerEntity` (default 200) of
 * the freshest live+embedded observations per entity via a windowed CTE before
 * the join. These tests prove the cap is honoured and that it keeps the
 * freshest observations.
 *
 * Requires sqlite-vec. No-ops on platforms without it. Runs under
 * MEMORY_EMBED_MOCK=1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-cap-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory_contradictions — per-entity observation cap', () => {
  it('only the freshest `maxObservationsPerEntity` observations enter the self-join', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'CapEntity', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;

    // Six observations forming three negation pairs. Give each a distinct
    // valid_from so "freshest" is deterministic (rapid inserts share the
    // same second otherwise).
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const o = await entityObserve({ entityId: eid, content: `signal ${Math.floor(i / 2)} is ${i % 2 === 0 ? '' : 'not '}on` });
      if (!o.success) throw new Error('observe failed');
      ids.push((o.data as { observationId: string }).observationId);
    }
    const db = getDb();
    // valid_from increasing with index → index 4 & 5 are the two freshest.
    for (let i = 0; i < 6; i++) {
      db.prepare('UPDATE entity_observations SET valid_from = ? WHERE id = ?').run(
        `2026-01-0${i + 1} 00:00:00`,
        ids[i]
      );
    }

    // Cap at 2 → only ids[4] + ids[5] survive into the join. They form one
    // negation pair ("signal 2 is on" / "signal 2 is not on"), so at most one
    // pair can come back, and only those two observation ids may appear.
    const r = contradictions({ entityId: eid, minCosine: 0.4, maxObservationsPerEntity: 2 });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as {
        pairs: Array<{ older: { id: string }; newer: { id: string } }>;
        thresholds: { maxObservationsPerEntity: number };
      };
      expect(d.thresholds.maxObservationsPerEntity).toBe(2);
      const seen = new Set<string>();
      for (const p of d.pairs) {
        seen.add(p.older.id);
        seen.add(p.newer.id);
      }
      // Every referenced observation must be one of the two freshest.
      const fresh = new Set([ids[4], ids[5]]);
      for (const obsId of seen) {
        expect(fresh.has(obsId)).toBe(true);
      }
      // At most one pair is possible from two observations.
      expect(d.pairs.length).toBeLessThanOrEqual(1);
    }
  });

  it('raising the cap surfaces older pairs that a low cap hides', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'CapWiden', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const o = await entityObserve({ entityId: eid, content: `flag ${Math.floor(i / 2)} is ${i % 2 === 0 ? '' : 'not '}set` });
      if (!o.success) throw new Error('observe failed');
      ids.push((o.data as { observationId: string }).observationId);
    }
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      db.prepare('UPDATE entity_observations SET valid_from = ? WHERE id = ?').run(
        `2026-02-0${i + 1} 00:00:00`,
        ids[i]
      );
    }

    const capped = contradictions({ entityId: eid, minCosine: 0.4, maxObservationsPerEntity: 2 });
    const wide = contradictions({ entityId: eid, minCosine: 0.4, maxObservationsPerEntity: 200 });
    expect(capped.success && wide.success).toBe(true);
    if (capped.success && wide.success) {
      const c = capped.data as { pairs: unknown[] };
      const w = wide.data as { pairs: unknown[] };
      // Three negation pairs exist; the low cap sees at most one, the wide cap
      // sees more of them.
      expect(w.pairs.length).toBeGreaterThan(c.pairs.length);
    }
  });

  it('defaults the cap to 200 and reports it in thresholds', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'CapDefault', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    await entityObserve({ entityId: eid, content: 'thing is fine' });

    const r = contradictions({ entityId: eid });
    if (r.success) {
      const d = r.data as { thresholds: { maxObservationsPerEntity: number } };
      expect(d.thresholds.maxObservationsPerEntity).toBe(200);
    }
  });

  it('rejects a cap below 2 (a pair needs two observations)', async () => {
    const { contradictionsSchema } = await import('./contradictions.js');
    expect(contradictionsSchema.safeParse({ maxObservationsPerEntity: 1 }).success).toBe(false);
    expect(contradictionsSchema.safeParse({ maxObservationsPerEntity: 2 }).success).toBe(true);
    expect(contradictionsSchema.safeParse({ maxObservationsPerEntity: 2001 }).success).toBe(false);
  });
});
