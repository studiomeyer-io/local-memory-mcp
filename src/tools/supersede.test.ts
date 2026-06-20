/**
 * Tests for memory_observation_supersede (v2.2.0) and the search-visibility
 * gate it relies on. Supersede is LLM-free + vec-free, so most cases run
 * regardless of whether sqlite-vec loaded. The vector-mode search gate is
 * guarded on isVectorEnabled().
 *
 * Harness mirrors contradictions.test.ts: tmp DB per case, MEMORY_EMBED_MOCK=1
 * from the npm test script, closeDb in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-supersede-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory_observation_supersede', () => {
  it('tombstones an observation: gone from live entity_open, kept for asOf', async () => {
    const { entityCreate, entityObserve, entityOpen, observationSupersede } = await import('./entity.js');

    const e = entityCreate({ name: 'AsOfCase', entityType: 'project' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;

    const obs = await entityObserve({ entityId: eid, content: 'status is on track' });
    if (!obs.success) throw new Error('observe failed');
    const obsId = (obs.data as { observationId: string }).observationId;

    // Retire with a far-future cutoff so the window math is deterministic
    // regardless of the test clock (valid_from = now, valid_to = 2099).
    const sup = observationSupersede({ observationId: obsId, validTo: '2099-01-01 00:00:00' });
    expect(sup.success).toBe(true);
    if (sup.success) expect((sup.data as { action: string }).action).toBe('superseded');

    // Live view: superseded obs no longer present.
    const live = entityOpen({ id: eid });
    if (!live.success) throw new Error('open failed');
    expect((live.data as { observations: unknown[] }).observations.length).toBe(0);

    // asOf inside the validity window (2050): obs is visible again.
    const at2050 = entityOpen({ id: eid, asOf: '2050-01-01' });
    if (!at2050.success) throw new Error('asOf failed');
    expect((at2050.data as { observations: unknown[] }).observations.length).toBe(1);

    // asOf after the cutoff (2099-06): obs hidden again.
    const at2099 = entityOpen({ id: eid, asOf: '2099-06-01' });
    if (!at2099.success) throw new Error('asOf failed');
    expect((at2099.data as { observations: unknown[] }).observations.length).toBe(0);
  });

  it('uses the newer observation valid_from as the cutoff when supersededById is given', async () => {
    const { entityCreate, entityObserve, observationSupersede, entityOpen } = await import('./entity.js');

    const e = entityCreate({ name: 'ZepCase', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;

    const older = await entityObserve({ entityId: eid, content: 'cache is redis' });
    const newer = await entityObserve({ entityId: eid, content: 'cache is now memcached' });
    if (!older.success || !newer.success) throw new Error('observe failed');
    const olderId = (older.data as { observationId: string }).observationId;
    const newerId = (newer.data as { observationId: string }).observationId;

    const sup = observationSupersede({ observationId: olderId, supersededById: newerId });
    expect(sup.success).toBe(true);
    if (sup.success) {
      const d = sup.data as { action: string; validTo: string; supersededById: string };
      expect(d.action).toBe('superseded');
      expect(typeof d.validTo).toBe('string');
      expect(d.supersededById).toBe(newerId);
    }

    // Only the newer fact remains live.
    const live = entityOpen({ id: eid });
    if (live.success) {
      const obs = (live.data as { observations: Array<{ content: string }> }).observations;
      expect(obs.length).toBe(1);
      expect(obs[0]!.content).toBe('cache is now memcached');
    }
  });

  it('removes a superseded observation from live FTS search but it stayed addressable', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const { search } = await import('./search.js');

    const e = entityCreate({ name: 'SearchGate', entityType: 'project' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;

    const obs = await entityObserve({ entityId: eid, content: 'the deploy uses kubernetes orchestration' });
    if (!obs.success) throw new Error('observe failed');
    const obsId = (obs.data as { observationId: string }).observationId;

    // Before: FTS search finds the observation.
    const before = await search({ query: 'kubernetes', mode: 'fts' });
    expect(before.success).toBe(true);
    if (before.success) {
      const ids = (before.data as { results: Array<{ id: string }> }).results.map((r) => r.id);
      expect(ids).toContain(obsId);
    }

    observationSupersede({ observationId: obsId });

    // After: the retired observation no longer surfaces in live search.
    const after = await search({ query: 'kubernetes', mode: 'fts' });
    expect(after.success).toBe(true);
    if (after.success) {
      const ids = (after.data as { results: Array<{ id: string }> }).results.map((r) => r.id);
      expect(ids).not.toContain(obsId);
    }
  });

  it('removes a superseded observation from vector-mode search too', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const e = entityCreate({ name: 'VecGate', entityType: 'project' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;

    const obs = await entityObserve({ entityId: eid, content: 'rollback strategy uses blue green deployment' });
    if (!obs.success) throw new Error('observe failed');
    const obsId = (obs.data as { observationId: string }).observationId;

    observationSupersede({ observationId: obsId });

    const after = await search({ query: 'blue green deployment', mode: 'vector' });
    expect(after.success).toBe(true);
    if (after.success) {
      const ids = (after.data as { results: Array<{ id: string }> }).results.map((r) => r.id);
      expect(ids).not.toContain(obsId);
    }
  });

  it('is idempotent: superseding twice reports already_superseded', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const e = entityCreate({ name: 'Idem', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'flag is on' });
    if (!obs.success) throw new Error('observe failed');
    const obsId = (obs.data as { observationId: string }).observationId;

    const first = observationSupersede({ observationId: obsId });
    expect(first.success).toBe(true);
    if (first.success) expect((first.data as { action: string }).action).toBe('superseded');

    const second = observationSupersede({ observationId: obsId });
    expect(second.success).toBe(true);
    if (second.success) expect((second.data as { action: string }).action).toBe('already_superseded');
  });

  it('returns NOT_FOUND for a missing observation', async () => {
    const { observationSupersede } = await import('./entity.js');
    const r = observationSupersede({ observationId: 'nope' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('NOT_FOUND');
  });

  it('returns SUPERSEDER_NOT_FOUND when the newer observation is missing', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const e = entityCreate({ name: 'MissingNewer', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'a fact' });
    if (!obs.success) throw new Error('observe failed');
    const obsId = (obs.data as { observationId: string }).observationId;

    const r = observationSupersede({ observationId: obsId, supersededById: 'ghost' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('SUPERSEDER_NOT_FOUND');
  });

  it('rejects a supersededById that belongs to a different entity (H4)', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const a = entityCreate({ name: 'EntA', entityType: 'project' });
    const b = entityCreate({ name: 'EntB', entityType: 'project' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const aid = (a.data as { id: string }).id;
    const bid = (b.data as { id: string }).id;
    const oa = await entityObserve({ entityId: aid, content: 'fact on A' });
    const ob = await entityObserve({ entityId: bid, content: 'fact on B' });
    if (!oa.success || !ob.success) throw new Error('observe failed');
    const oaId = (oa.data as { observationId: string }).observationId;
    const obId = (ob.data as { observationId: string }).observationId;

    const r = observationSupersede({ observationId: oaId, supersededById: obId });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('CROSS_ENTITY_SUPERSEDE');
  });

  it('rejects self-supersession', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const e = entityCreate({ name: 'Self', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'a fact' });
    if (!obs.success) throw new Error('observe failed');
    const obsId = (obs.data as { observationId: string }).observationId;

    const r = observationSupersede({ observationId: obsId, supersededById: obsId });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('SELF_SUPERSEDE');
  });

  it('flags an inverted validity window with a note', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const e = entityCreate({ name: 'Inverted', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'created today' });
    if (!obs.success) throw new Error('observe failed');
    const obsId = (obs.data as { observationId: string }).observationId;

    // Cutoff well before valid_from → inverted window.
    const r = observationSupersede({ observationId: obsId, validTo: '2000-01-01 00:00:00' });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as { note?: string }).note).toBeDefined();
  });
});
