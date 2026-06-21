/**
 * v2.3.0 critical-path tests requested in the quality pass. These target exact
 * window boundaries and guard rails that the broader suites don't pin down:
 *
 *   - entity_open({asOf}) at the valid_to == asOf edge (half-open window).
 *   - entity_open({asOf}) at the valid_from == asOf edge (inclusive lower).
 *   - observationSupersede inverted-window guard (cutoff == valid_from).
 *   - contradictions scope NOT_FOUND for a missing entityName.
 *
 * Where the existing suites already cover a behaviour, these add the *distinct
 * boundary* case rather than duplicating. Runs under MEMORY_EMBED_MOCK=1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-crit-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('entity_open({asOf}) — window boundary edges', () => {
  it('excludes an observation whose valid_to EXACTLY equals asOf (half-open window)', async () => {
    // The query is valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf).
    // At asOf == valid_to the fact has just stopped being true, so it must NOT
    // appear — the window is [valid_from, valid_to).
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');

    const e = entityCreate({ name: 'Boundary', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'retired exactly at the cutoff' });
    if (!obs.success) throw new Error('observe failed');
    const oid = (obs.data as { observationId: string }).observationId;

    // Window: valid_from 2026-01-01, valid_to 2026-03-01.
    getDb()
      .prepare('UPDATE entity_observations SET valid_from = ?, valid_to = ? WHERE id = ?')
      .run('2026-01-01 00:00:00', '2026-03-01 00:00:00', oid);

    // asOf == valid_to → excluded.
    const at = entityOpen({ id: eid, asOf: '2026-03-01 00:00:00' });
    expect(at.success).toBe(true);
    if (at.success) {
      const d = at.data as { observations: Array<{ id: string }> };
      expect(d.observations.find((o) => o.id === oid)).toBeUndefined();
    }

    // One second before the cutoff → still live.
    const justBefore = entityOpen({ id: eid, asOf: '2026-02-28 23:59:59' });
    if (justBefore.success) {
      const d = justBefore.data as { observations: Array<{ id: string }> };
      expect(d.observations.some((o) => o.id === oid)).toBe(true);
    }
  });

  it('includes an observation whose valid_from EXACTLY equals asOf (inclusive lower bound)', async () => {
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');

    const e = entityCreate({ name: 'LowerEdge', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'became true exactly at asOf' });
    if (!obs.success) throw new Error('observe failed');
    const oid = (obs.data as { observationId: string }).observationId;

    getDb()
      .prepare('UPDATE entity_observations SET valid_from = ?, valid_to = NULL WHERE id = ?')
      .run('2026-04-15 00:00:00', oid);

    // asOf == valid_from → included (valid_from <= asOf is inclusive).
    const at = entityOpen({ id: eid, asOf: '2026-04-15 00:00:00' });
    expect(at.success).toBe(true);
    if (at.success) {
      const d = at.data as { observations: Array<{ id: string }> };
      expect(d.observations.some((o) => o.id === oid)).toBe(true);
    }

    // One second before valid_from → not yet true.
    const before = entityOpen({ id: eid, asOf: '2026-04-14 23:59:59' });
    if (before.success) {
      const d = before.data as { observations: Array<{ id: string }> };
      expect(d.observations.find((o) => o.id === oid)).toBeUndefined();
    }
  });
});

describe('observationSupersede — inverted-window guard', () => {
  it('flags note when the explicit validTo equals the observation valid_from (degenerate window)', async () => {
    // valid_to == valid_from means the window [from, to) is empty → the fact is
    // never live at any instant. Allowed (retroactive retire) but must surface a
    // note so it is not a silent surprise in a later asOf query.
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');

    const e = entityCreate({ name: 'Degenerate', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'fact with a known start' });
    if (!obs.success) throw new Error('observe failed');
    const oid = (obs.data as { observationId: string }).observationId;

    getDb()
      .prepare('UPDATE entity_observations SET valid_from = ? WHERE id = ?')
      .run('2026-05-01 00:00:00', oid);

    // Cutoff EXACTLY at valid_from → inverted (empty) window → note expected.
    const r = observationSupersede({ observationId: oid, validTo: '2026-05-01 00:00:00' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { action: string; validTo: string; note?: string };
      expect(d.action).toBe('superseded');
      expect(d.note).toBeDefined();
      expect(d.note).toMatch(/will not be live/i);
    }
  });

  it('does NOT flag the note for a normal forward window (cutoff after valid_from)', async () => {
    const { entityCreate, entityObserve, observationSupersede } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');

    const e = entityCreate({ name: 'Forward', entityType: 'concept' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'fact retired later, normally' });
    if (!obs.success) throw new Error('observe failed');
    const oid = (obs.data as { observationId: string }).observationId;

    getDb()
      .prepare('UPDATE entity_observations SET valid_from = ? WHERE id = ?')
      .run('2026-05-01 00:00:00', oid);

    const r = observationSupersede({ observationId: oid, validTo: '2026-06-01 00:00:00' });
    if (r.success) {
      const d = r.data as { note?: string };
      expect(d.note).toBeUndefined();
    }
  });
});

describe('memory_contradictions — scope NOT_FOUND', () => {
  it('returns NOT_FOUND when entityName resolves to no entity', async () => {
    const { contradictions } = await import('./contradictions.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const r = contradictions({ entityName: 'NoSuchEntityName', entityType: 'concept' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.code).toBe('NOT_FOUND');
    }
  });

  it('resolves an existing entityName+entityType to a scoped scan (scope echoes the id)', async () => {
    const { entityCreate, entityObserve, contradictions } = await import('./entity.js').then(async (m) => ({
      ...m,
      contradictions: (await import('./contradictions.js')).contradictions,
    }));
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = entityCreate({ name: 'ScopedName', entityType: 'project' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    await entityObserve({ entityId: eid, content: 'status is green' });

    const r = contradictions({ entityName: 'ScopedName', entityType: 'project' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { scope: string };
      expect(d.scope).toBe(`entity:${eid}`);
    }
  });
});
