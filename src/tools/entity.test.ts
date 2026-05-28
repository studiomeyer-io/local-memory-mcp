/**
 * Tests for the entity (knowledge graph) layer.
 *
 * Covers all six tool surfaces: create, observe, search, open, relate, delete.
 * Uses the same per-test tmp sqlite pattern as learn.test.ts so cases don't
 * leak state and the real schema (including triggers) is exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-entity-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('entityCreate', () => {
  it('creates a new entity and returns action=created', async () => {
    const { entityCreate } = await import('./entity.js');
    const result = entityCreate({ name: 'Claude', entityType: 'tool' });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { id: string; action: string };
      expect(data.action).toBe('created');
      expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('returns action=existing on second call with same name+type', async () => {
    const { entityCreate } = await import('./entity.js');
    const first = entityCreate({ name: 'Matthias', entityType: 'person' });
    const second = entityCreate({ name: 'Matthias', entityType: 'person' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect((second.data as { action: string }).action).toBe('existing');
      expect((second.data as { id: string }).id).toBe((first.data as { id: string }).id);
    }
  });

  it('treats same name with different type as different entities', async () => {
    const { entityCreate } = await import('./entity.js');
    const a = entityCreate({ name: 'Foo', entityType: 'project' });
    const b = entityCreate({ name: 'Foo', entityType: 'tool' });
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) {
      expect((a.data as { id: string }).id).not.toBe((b.data as { id: string }).id);
    }
  });

  it('updates summary when re-creating an existing entity with summary', async () => {
    const { entityCreate, entityOpen } = await import('./entity.js');
    entityCreate({ name: 'Ada', entityType: 'person' });
    entityCreate({ name: 'Ada', entityType: 'person', summary: 'mathematician' });
    const open = entityOpen({ name: 'Ada', entityType: 'person' });
    expect(open.success).toBe(true);
    if (open.success) {
      const d = open.data as { entity: { summary: string | null } };
      expect(d.entity.summary).toBe('mathematician');
    }
  });

  it('respects custom confidence value', async () => {
    const { entityCreate, entityOpen } = await import('./entity.js');
    const created = entityCreate({ name: 'Edge', entityType: 'concept', confidence: 0.3 });
    expect(created.success).toBe(true);
    if (created.success) {
      const id = (created.data as { id: string }).id;
      const open = entityOpen({ id });
      if (open.success) {
        const d = open.data as { entity: { confidence: number } };
        expect(d.entity.confidence).toBeCloseTo(0.3, 5);
      }
    }
  });

  it('rejects empty name via zod schema', async () => {
    const { entityCreateSchema } = await import('./entity.js');
    const parsed = entityCreateSchema.safeParse({ name: '', entityType: 'person' });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing entityType via zod schema', async () => {
    const { entityCreateSchema } = await import('./entity.js');
    const parsed = entityCreateSchema.safeParse({ name: 'Foo' });
    expect(parsed.success).toBe(false);
  });
});

describe('entityObserve', () => {
  it('attaches an observation to an existing entity by id', async () => {
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const created = entityCreate({ name: 'Server', entityType: 'infrastructure' });
    if (!created.success) throw new Error('setup failed');
    const id = (created.data as { id: string }).id;
    const obs = await entityObserve({ entityId: id, content: 'Disk at 77%' });
    expect(obs.success).toBe(true);

    const open = entityOpen({ id });
    if (open.success) {
      const d = open.data as { observations: Array<{ content: string }> };
      expect(d.observations.length).toBe(1);
      expect(d.observations[0]?.content).toBe('Disk at 77%');
    }
  });

  it('auto-creates the entity when observing by name+type', async () => {
    const { entityObserve, entityOpen } = await import('./entity.js');
    const obs = await entityObserve({
      entityName: 'NewThing',
      entityType: 'tool',
      content: 'first observation',
    });
    expect(obs.success).toBe(true);

    const open = entityOpen({ name: 'NewThing', entityType: 'tool' });
    expect(open.success).toBe(true);
    if (open.success) {
      const d = open.data as { observations: Array<{ content: string }> };
      expect(d.observations[0]?.content).toBe('first observation');
    }
  });

  it('fails with MISSING_ENTITY_REF when neither id nor name+type is passed', async () => {
    const { entityObserve } = await import('./entity.js');
    const obs = await entityObserve({ content: 'orphan' });
    expect(obs.success).toBe(false);
    if (!obs.success) {
      expect(obs.code).toBe('MISSING_ENTITY_REF');
    }
  });

  it('fails with MISSING_ENTITY_REF when only name is passed without type', async () => {
    const { entityObserve } = await import('./entity.js');
    const obs = await entityObserve({ entityName: 'Foo', content: 'hi' });
    expect(obs.success).toBe(false);
    if (!obs.success) {
      expect(obs.code).toBe('MISSING_ENTITY_REF');
    }
  });

  it('bumps entity updated_at when a new observation lands', async () => {
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');

    const created = entityCreate({ name: 'Timely', entityType: 'tool' });
    if (!created.success) throw new Error('setup failed');
    const id = (created.data as { id: string }).id;

    // Rewind updated_at by one day so the bump is observable at second resolution.
    const db = getDb();
    db.prepare("UPDATE entities SET updated_at = datetime('now', '-1 day') WHERE id = ?").run(id);
    const before = (db.prepare('SELECT updated_at FROM entities WHERE id = ?').get(id) as { updated_at: string }).updated_at;

    await entityObserve({ entityId: id, content: 'new fact' });

    const open = entityOpen({ id });
    if (open.success) {
      const d = open.data as { entity: { updated_at: string } };
      expect(d.entity.updated_at > before).toBe(true);
    }
  });

  it('rejects empty content via zod schema', async () => {
    const { entityObserveSchema } = await import('./entity.js');
    const parsed = entityObserveSchema.safeParse({ entityId: 'x', content: '' });
    expect(parsed.success).toBe(false);
  });

  it('accepts custom source and confidence on the observation', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'SrcTest', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const id = (created.data as { id: string }).id;
    const obs = await entityObserve({
      entityId: id,
      content: 'from a book',
      source: 'library',
      confidence: 0.4,
    });
    expect(obs.success).toBe(true);
    const db = getDb();
    const row = db
      .prepare('SELECT source, confidence FROM entity_observations WHERE entity_id = ?')
      .get(id) as { source: string; confidence: number };
    expect(row.source).toBe('library');
    expect(row.confidence).toBeCloseTo(0.4, 5);
  });
});

describe('entitySearch', () => {
  it('finds an entity by name via FTS5', async () => {
    const { entityCreate, entitySearch } = await import('./entity.js');
    entityCreate({ name: 'Kafka', entityType: 'tool', summary: 'streaming platform' });
    entityCreate({ name: 'Redis', entityType: 'tool', summary: 'in-memory store' });
    const result = entitySearch({ query: 'Kafka' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: Array<{ name: string }> };
      expect(d.results.length).toBe(1);
      expect(d.results[0]?.name).toBe('Kafka');
    }
  });

  it('finds an entity via observation content (FTS5 join)', async () => {
    const { entityCreate, entityObserve, entitySearch } = await import('./entity.js');
    const created = entityCreate({ name: 'Alpha', entityType: 'project' });
    if (!created.success) throw new Error('setup failed');
    await entityObserve({ entityId: (created.data as { id: string }).id, content: 'runs on kubernetes' });
    const result = entitySearch({ query: 'kubernetes' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: Array<{ name: string }> };
      expect(d.results.map((r) => r.name)).toContain('Alpha');
    }
  });

  it('respects the entityType filter', async () => {
    const { entityCreate, entitySearch } = await import('./entity.js');
    entityCreate({ name: 'ACME', entityType: 'company', summary: 'company one' });
    entityCreate({ name: 'ACME', entityType: 'tool', summary: 'tool one' });
    const result = entitySearch({ query: 'ACME', entityType: 'tool' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: Array<{ entity_type: string }> };
      expect(d.results.length).toBe(1);
      expect(d.results[0]?.entity_type).toBe('tool');
    }
  });

  it('entityType filter also applies to observation-only matches (pushed-down filter)', async () => {
    const { entityCreate, entityObserve, entitySearch } = await import('./entity.js');
    // Two entities of different types whose observations both mention the
    // search term. Only the tool should come back when we filter on type.
    const tool = entityCreate({ name: 'SynthA', entityType: 'tool', summary: 'x' });
    const person = entityCreate({ name: 'SynthB', entityType: 'person', summary: 'y' });
    if (!tool.success || !person.success) throw new Error('setup failed');
    await entityObserve({
      entityName: 'SynthA',
      entityType: 'tool',
      content: 'mentions Zepto-Observation explicitly',
    });
    await entityObserve({
      entityName: 'SynthB',
      entityType: 'person',
      content: 'mentions Zepto-Observation explicitly',
    });

    const result = entitySearch({ query: 'Zepto-Observation', entityType: 'tool' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: Array<{ entity_type: string; name: string }> };
      expect(d.results.length).toBe(1);
      expect(d.results[0]?.entity_type).toBe('tool');
      expect(d.results[0]?.name).toBe('SynthA');
    }
  });

  it('respects the limit parameter', async () => {
    const { entityCreate, entitySearch } = await import('./entity.js');
    for (let i = 0; i < 5; i++) {
      entityCreate({ name: `Beta${i}`, entityType: 'project', summary: 'same phrase' });
    }
    const result = entitySearch({ query: 'phrase', limit: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: unknown[]; count: number };
      expect(d.results.length).toBe(2);
      expect(d.count).toBe(2);
    }
  });

  it('returns empty results (not an error) for a query with zero matches', async () => {
    const { entitySearch } = await import('./entity.js');
    const result = entitySearch({ query: 'totallyabsenttermxyz' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: unknown[] };
      expect(d.results.length).toBe(0);
    }
  });

  it('returns an observation-only hit when the entity name does not match', async () => {
    const { entityCreate, entityObserve, entitySearch } = await import('./entity.js');
    entityCreate({ name: 'UnrelatedName', entityType: 'tool', summary: 'something else' });
    await entityObserve({
      entityName: 'UnrelatedName',
      entityType: 'tool',
      content: 'this observation references ObsOnlyKeyword quite clearly',
    });
    const result = entitySearch({ query: 'ObsOnlyKeyword' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: Array<{ name: string }> };
      expect(d.results.length).toBe(1);
      expect(d.results[0]?.name).toBe('UnrelatedName');
    }
  });

  it('FTS search is case-insensitive on both name and observation legs', async () => {
    const { entityCreate, entityObserve, entitySearch } = await import('./entity.js');
    entityCreate({ name: 'MixedCaseName', entityType: 'project', summary: 'summaryTEXT' });
    await entityObserve({
      entityName: 'MixedCaseName',
      entityType: 'project',
      content: 'observation with MixedKeywordExample inside',
    });
    // SQLite FTS5 tokenizer is case-insensitive by default — verify with
    // queries in the opposite case from what was stored.
    const r1 = entitySearch({ query: 'mixedcasename' });
    expect(r1.success).toBe(true);
    if (r1.success) {
      expect((r1.data as { results: unknown[] }).results.length).toBe(1);
    }
    const r2 = entitySearch({ query: 'MIXEDKEYWORDEXAMPLE' });
    expect(r2.success).toBe(true);
    if (r2.success) {
      expect((r2.data as { results: unknown[] }).results.length).toBe(1);
    }
  });

  it('handles an empty FTS MATCH result without falling into the LIKE fallback', async () => {
    const { entityCreate, entitySearch } = await import('./entity.js');
    entityCreate({ name: 'Solo', entityType: 'tool', summary: 'x' });
    // A quoted phrase that cannot match any token is a valid FTS query
    // returning zero rows — not an error. The code must keep going rather
    // than raise to the LIKE fallback.
    const result = entitySearch({ query: '"absolutelynomatchtoken"' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { results: unknown[] };
      expect(d.results.length).toBe(0);
    }
  });

  it('rejects empty query via zod schema', async () => {
    const { entitySearchSchema } = await import('./entity.js');
    expect(entitySearchSchema.safeParse({ query: '' }).success).toBe(false);
  });
});

describe('entityOpen', () => {
  it('returns NOT_FOUND when neither id nor name is given', async () => {
    const { entityOpen } = await import('./entity.js');
    const result = entityOpen({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  it('returns NOT_FOUND for a non-existent id', async () => {
    const { entityOpen } = await import('./entity.js');
    const result = entityOpen({ id: 'nonexistent-id' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  it('finds by id and returns observations + relations', async () => {
    const { entityCreate, entityObserve, entityRelate, entityOpen } = await import('./entity.js');
    const a = entityCreate({ name: 'Hub', entityType: 'tool' });
    const b = entityCreate({ name: 'Node', entityType: 'tool' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const aid = (a.data as { id: string }).id;
    const bid = (b.data as { id: string }).id;
    await entityObserve({ entityId: aid, content: 'obs one' });
    await entityObserve({ entityId: aid, content: 'obs two' });
    entityRelate({ fromEntityId: aid, toEntityId: bid, relationType: 'connects_to' });

    const open = entityOpen({ id: aid });
    expect(open.success).toBe(true);
    if (open.success) {
      const d = open.data as {
        entity: { id: string };
        observations: Array<{ content: string }>;
        relations: Array<{ relation_type: string; direction: string }>;
      };
      expect(d.entity.id).toBe(aid);
      expect(d.observations.length).toBe(2);
      expect(d.relations.length).toBe(1);
      expect(d.relations[0]?.relation_type).toBe('connects_to');
      expect(d.relations[0]?.direction).toBe('out');
    }
  });

  it('also returns inbound relations for the opened entity', async () => {
    const { entityCreate, entityRelate, entityOpen } = await import('./entity.js');
    const a = entityCreate({ name: 'Target', entityType: 'tool' });
    const b = entityCreate({ name: 'Caller', entityType: 'tool' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const aid = (a.data as { id: string }).id;
    const bid = (b.data as { id: string }).id;
    entityRelate({ fromEntityId: bid, toEntityId: aid, relationType: 'depends_on' });

    const open = entityOpen({ id: aid });
    if (open.success) {
      const d = open.data as { relations: Array<{ direction: string }> };
      expect(d.relations.length).toBe(1);
      expect(d.relations[0]?.direction).toBe('in');
    }
  });

  it('finds by name without type when name is unique', async () => {
    const { entityCreate, entityOpen } = await import('./entity.js');
    entityCreate({ name: 'UniqueName', entityType: 'concept' });
    const open = entityOpen({ name: 'UniqueName' });
    expect(open.success).toBe(true);
    if (open.success) {
      const d = open.data as { entity: { name: string } };
      expect(d.entity.name).toBe('UniqueName');
    }
  });

  it('only returns observations where valid_to IS NULL (bi-temporal)', async () => {
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'Temporal', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const id = (created.data as { id: string }).id;
    await entityObserve({ entityId: id, content: 'active fact' });
    await entityObserve({ entityId: id, content: 'retired fact' });

    // Retire one observation by setting valid_to.
    getDb()
      .prepare("UPDATE entity_observations SET valid_to = datetime('now') WHERE content = ?")
      .run('retired fact');

    const open = entityOpen({ id });
    if (open.success) {
      const d = open.data as { observations: Array<{ content: string }> };
      expect(d.observations.length).toBe(1);
      expect(d.observations[0]?.content).toBe('active fact');
    }
  });

  // ─── P3.1 v2.1.0 — asOf bi-temporal query ──────────

  it('asOf returns observations valid at that instant (in-window + closed-window)', async () => {
    // Three observations on the same entity with carefully set valid_from /
    // valid_to spans. The asOf query must return only those whose validity
    // window contains the asOf timestamp.
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'TimelineEntity', entityType: 'person' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;

    // We'll observe three facts and then manually rewrite valid_from / valid_to
    // so the test is independent of wall-clock.
    const o1 = await entityObserve({ entityId: eid, content: 'fact A (old, now retired)' });
    const o2 = await entityObserve({ entityId: eid, content: 'fact B (still current)' });
    const o3 = await entityObserve({ entityId: eid, content: 'fact C (added later)' });
    if (!o1.success || !o2.success || !o3.success) throw new Error('observe failed');
    const id1 = (o1.data as { observationId: string }).observationId;
    const id2 = (o2.data as { observationId: string }).observationId;
    const id3 = (o3.data as { observationId: string }).observationId;

    const db = getDb();
    // Layout (all UTC):
    //   o1: valid_from 2026-01-01, valid_to 2026-03-01  → retired
    //   o2: valid_from 2026-02-01, valid_to NULL        → still live
    //   o3: valid_from 2026-04-01, valid_to NULL        → added later
    db.prepare('UPDATE entity_observations SET valid_from = ?, valid_to = ? WHERE id = ?')
      .run('2026-01-01 00:00:00', '2026-03-01 00:00:00', id1);
    db.prepare('UPDATE entity_observations SET valid_from = ?, valid_to = NULL WHERE id = ?')
      .run('2026-02-01 00:00:00', id2);
    db.prepare('UPDATE entity_observations SET valid_from = ?, valid_to = NULL WHERE id = ?')
      .run('2026-04-01 00:00:00', id3);

    // asOf 2026-02-15: o1 (still live, valid_to in future) + o2 (live), NO o3 (not yet).
    const at0215 = entityOpen({ id: eid, asOf: '2026-02-15' });
    expect(at0215.success).toBe(true);
    if (at0215.success) {
      const d = at0215.data as {
        observations: Array<{ id: string; content: string }>;
        asOf: string;
      };
      expect(d.asOf).toBe('2026-02-15');
      const ids = d.observations.map((o) => o.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).not.toContain(id3);
    }

    // asOf 2026-03-15: o1 retired (valid_to passed), o2 live, o3 not yet.
    const at0315 = entityOpen({ id: eid, asOf: '2026-03-15' });
    if (at0315.success) {
      const d = at0315.data as { observations: Array<{ id: string }> };
      const ids = d.observations.map((o) => o.id);
      expect(ids).not.toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).not.toContain(id3);
    }

    // asOf 2026-05-01: o2 + o3 live, o1 retired.
    const at0501 = entityOpen({ id: eid, asOf: '2026-05-01' });
    if (at0501.success) {
      const d = at0501.data as { observations: Array<{ id: string }> };
      const ids = d.observations.map((o) => o.id);
      expect(ids).not.toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).toContain(id3);
    }
  });

  it('asOf accepts both ISO 8601 (with T) and SQLite-style (with space) formats', async () => {
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'FormatTest', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'observation under test' });
    if (!obs.success) throw new Error('observe failed');

    // Pin a known valid_from we can probe with multiple format strings.
    getDb()
      .prepare('UPDATE entity_observations SET valid_from = ? WHERE entity_id = ?')
      .run('2026-06-15 12:00:00', eid);

    for (const asOf of [
      '2026-06-16',                  // date-only
      '2026-06-16 00:00:00',         // SQLite-style
      '2026-06-16T00:00:00',         // ISO-8601 (no Z)
      '2026-06-16T00:00:00Z',        // ISO-8601 UTC
    ]) {
      const r = entityOpen({ id: eid, asOf });
      expect(r.success).toBe(true);
      if (r.success) {
        const d = r.data as { observations: unknown[] };
        expect(d.observations.length).toBe(1);
      }
    }
  });

  it('asOf earlier than any valid_from returns zero observations (entity existed but had no facts yet)', async () => {
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'PreObsEntity', entityType: 'project' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    await entityObserve({ entityId: eid, content: 'a fact from later' });

    getDb()
      .prepare('UPDATE entity_observations SET valid_from = ? WHERE entity_id = ?')
      .run('2026-05-01 00:00:00', eid);

    const result = entityOpen({ id: eid, asOf: '2026-01-01' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { observations: unknown[]; asOf: string };
      expect(d.observations.length).toBe(0);
      expect(d.asOf).toBe('2026-01-01');
    }
  });

  it('asOf without value still returns the legacy live-only view (backward compat)', async () => {
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'LegacyView', entityType: 'tool' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    await entityObserve({ entityId: eid, content: 'live obs' });
    await entityObserve({ entityId: eid, content: 'retired obs' });
    getDb()
      .prepare("UPDATE entity_observations SET valid_to = datetime('now') WHERE content = ?")
      .run('retired obs');

    const result = entityOpen({ id: eid });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { observations: Array<{ content: string }>; asOf?: string };
      expect(d.observations.length).toBe(1);
      expect(d.observations[0]?.content).toBe('live obs');
      // The data payload must NOT carry an asOf key when the caller didn't
      // pass one — otherwise clients will think they queried at "undefined".
      expect(d.asOf).toBeUndefined();
    }
  });

  it('asOf rejects an unparseable string via the Zod schema', async () => {
    const { entityOpenSchema } = await import('./entity.js');
    const parsed = entityOpenSchema.safeParse({ id: 'x', asOf: 'not-a-date' });
    expect(parsed.success).toBe(false);
  });

  // ─── R1 Analyst — missing asOf boundary coverage ───

  it('asOf exactly equal to valid_from INCLUDES the observation (boundary: <=)', async () => {
    // The asOf predicate is `datetime(valid_from) <= datetime(?)`. When asOf
    // equals valid_from exactly, the observation must be returned. This is
    // the boundary case a future predicate refactor could silently flip
    // (e.g. by changing `<=` to `<` and losing the inclusive lower bound).
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'BoundaryEntity', entityType: 'concept' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'observation on the boundary' });
    if (!obs.success) throw new Error('observe failed');

    getDb()
      .prepare('UPDATE entity_observations SET valid_from = ? WHERE entity_id = ?')
      .run('2026-07-04 12:00:00', eid);

    // asOf exactly equals valid_from.
    const r = entityOpen({ id: eid, asOf: '2026-07-04 12:00:00' });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { observations: Array<{ content: string }> };
      expect(d.observations.length).toBe(1);
      expect(d.observations[0]?.content).toBe('observation on the boundary');
    }

    // One second BEFORE the boundary → still observation not yet valid.
    const before = entityOpen({ id: eid, asOf: '2026-07-04 11:59:59' });
    if (before.success) {
      const d = before.data as { observations: unknown[] };
      expect(d.observations.length).toBe(0);
    }
  });

  it('asOf in the future returns every live observation', async () => {
    // A common-sense case: asking "what will I know after eternity?" should
    // return everything currently live (valid_to IS NULL). The future bound
    // also exercises the right side of the predicate for valid_to.
    const { entityCreate, entityObserve, entityOpen } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'FutureEntity', entityType: 'project' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    await entityObserve({ entityId: eid, content: 'live A' });
    await entityObserve({ entityId: eid, content: 'live B' });
    // Plant one retired observation to confirm asOf-in-future doesn't
    // resurrect it (valid_to predicate guard).
    await entityObserve({ entityId: eid, content: 'retired C' });
    getDb()
      .prepare("UPDATE entity_observations SET valid_to = datetime('now') WHERE content = ?")
      .run('retired C');

    const result = entityOpen({ id: eid, asOf: '2099-12-31' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { observations: Array<{ content: string }> };
      const contents = d.observations.map((o) => o.content);
      expect(contents).toContain('live A');
      expect(contents).toContain('live B');
      expect(contents).not.toContain('retired C');
    }
  });

  it('FTS index stays consistent when an observation content is updated (obs_au trigger)', async () => {
    // The observation table has ai/ad triggers; obs_au was added so a future
    // "edit observation" path doesn't leave stale rows in search_fts pointing
    // at the old content. We exercise it directly with an UPDATE here.
    const { entityCreate, entityObserve, entitySearch } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'TriggerHost', entityType: 'project' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    const obs = await entityObserve({ entityId: eid, content: 'original text with snowleopard' });
    if (!obs.success) throw new Error('setup failed');
    const oid = (obs.data as { observationId: string }).observationId;

    // Baseline: search hits on the original term.
    const before = entitySearch({ query: 'snowleopard' });
    if (before.success) {
      expect(
        (before.data as { results: Array<{ name: string }> }).results.map((r) => r.name),
      ).toContain('TriggerHost');
    }

    // Direct UPDATE (simulating a future edit path).
    getDb()
      .prepare('UPDATE entity_observations SET content = ? WHERE id = ?')
      .run('replacement text with polarbear', oid);

    // After UPDATE, the old token must not hit anymore…
    const afterOld = entitySearch({ query: 'snowleopard' });
    if (afterOld.success) {
      const names = (afterOld.data as { results: Array<{ name: string }> }).results.map(
        (r) => r.name,
      );
      expect(names).not.toContain('TriggerHost');
    }
    // …and the new token must hit.
    const afterNew = entitySearch({ query: 'polarbear' });
    if (afterNew.success) {
      const names = (afterNew.data as { results: Array<{ name: string }> }).results.map(
        (r) => r.name,
      );
      expect(names).toContain('TriggerHost');
    }
  });
});

describe('entityRelate', () => {
  it('creates a new relation', async () => {
    const { entityCreate, entityRelate } = await import('./entity.js');
    const a = entityCreate({ name: 'A', entityType: 'tool' });
    const b = entityCreate({ name: 'B', entityType: 'tool' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const result = entityRelate({
      fromEntityId: (a.data as { id: string }).id,
      toEntityId: (b.data as { id: string }).id,
      relationType: 'feeds',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('returns DUPLICATE_RELATION on the second identical insert', async () => {
    const { entityCreate, entityRelate } = await import('./entity.js');
    const a = entityCreate({ name: 'Dup1', entityType: 'tool' });
    const b = entityCreate({ name: 'Dup2', entityType: 'tool' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const args = {
      fromEntityId: (a.data as { id: string }).id,
      toEntityId: (b.data as { id: string }).id,
      relationType: 'feeds',
    };
    const first = entityRelate(args);
    const second = entityRelate(args);
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.code).toBe('DUPLICATE_RELATION');
    }
  });

  it('allows the same two entities with a different relation_type', async () => {
    const { entityCreate, entityRelate } = await import('./entity.js');
    const a = entityCreate({ name: 'X', entityType: 'tool' });
    const b = entityCreate({ name: 'Y', entityType: 'tool' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const aid = (a.data as { id: string }).id;
    const bid = (b.data as { id: string }).id;
    expect(entityRelate({ fromEntityId: aid, toEntityId: bid, relationType: 'feeds' }).success).toBe(true);
    expect(entityRelate({ fromEntityId: aid, toEntityId: bid, relationType: 'replaces' }).success).toBe(true);
  });

  it('stores a custom weight when provided', async () => {
    const { entityCreate, entityRelate } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const a = entityCreate({ name: 'WF', entityType: 'tool' });
    const b = entityCreate({ name: 'WT', entityType: 'tool' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const result = entityRelate({
      fromEntityId: (a.data as { id: string }).id,
      toEntityId: (b.data as { id: string }).id,
      relationType: 'uses',
      weight: 0.25,
    });
    if (result.success) {
      const row = getDb()
        .prepare('SELECT weight FROM entity_relations WHERE id = ?')
        .get((result.data as { id: string }).id) as { weight: number };
      expect(row.weight).toBeCloseTo(0.25, 5);
    }
  });

  it('surfaces INSERT_FAILED when from-entity does not exist (FK violation)', async () => {
    const { entityCreate, entityRelate } = await import('./entity.js');
    const b = entityCreate({ name: 'Real', entityType: 'tool' });
    if (!b.success) throw new Error('setup failed');
    const result = entityRelate({
      fromEntityId: 'does-not-exist',
      toEntityId: (b.data as { id: string }).id,
      relationType: 'links',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('INSERT_FAILED');
    }
  });
});

describe('entityDelete', () => {
  it('deletes an existing entity', async () => {
    const { entityCreate, entityDelete, entityOpen } = await import('./entity.js');
    const created = entityCreate({ name: 'Gone', entityType: 'tool' });
    if (!created.success) throw new Error('setup failed');
    const id = (created.data as { id: string }).id;
    const del = entityDelete({ id });
    expect(del.success).toBe(true);
    const after = entityOpen({ id });
    expect(after.success).toBe(false);
  });

  it('returns NOT_FOUND when deleting a non-existent id', async () => {
    const { entityDelete } = await import('./entity.js');
    const del = entityDelete({ id: 'never-existed' });
    expect(del.success).toBe(false);
    if (!del.success) {
      expect(del.code).toBe('NOT_FOUND');
    }
  });

  it('cascades observations + relations when the entity is deleted', async () => {
    const { entityCreate, entityObserve, entityRelate, entityDelete } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const a = entityCreate({ name: 'Casc1', entityType: 'tool' });
    const b = entityCreate({ name: 'Casc2', entityType: 'tool' });
    if (!a.success || !b.success) throw new Error('setup failed');
    const aid = (a.data as { id: string }).id;
    const bid = (b.data as { id: string }).id;
    await entityObserve({ entityId: aid, content: 'will vanish' });
    entityRelate({ fromEntityId: aid, toEntityId: bid, relationType: 'uses' });

    entityDelete({ id: aid });

    const db = getDb();
    const obsLeft = db
      .prepare('SELECT COUNT(*) AS c FROM entity_observations WHERE entity_id = ?')
      .get(aid) as { c: number };
    const relLeft = db
      .prepare('SELECT COUNT(*) AS c FROM entity_relations WHERE from_entity_id = ? OR to_entity_id = ?')
      .get(aid, aid) as { c: number };
    expect(obsLeft.c).toBe(0);
    expect(relLeft.c).toBe(0);
  });

  it('F3 fix: cascades observation embeddings when the entity is deleted', async () => {
    // Regression guard for the Critic R1 finding: entity_delete must also
    // remove the vector rows whose content_id matches the deleted entity's
    // observations. Previously those rows became unreachable ghosts because
    // sqlite-vec is outside the FK graph (vec0 doesn't model FKs).
    const { entityCreate, entityObserve, entityDelete } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const e = entityCreate({ name: 'Ghost', entityType: 'tool' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    const obs1 = await entityObserve({ entityId: eid, content: 'observation alpha for cascade test' });
    const obs2 = await entityObserve({ entityId: eid, content: 'observation beta for cascade test' });
    if (!obs1.success || !obs2.success) throw new Error('observe failed');
    const obsId1 = (obs1.data as { observationId: string }).observationId;
    const obsId2 = (obs2.data as { observationId: string }).observationId;

    const db = getDb();
    // Sanity check: embeddings exist before delete.
    const before = db
      .prepare('SELECT content_id FROM embeddings WHERE content_id IN (?, ?)')
      .all(obsId1, obsId2) as Array<{ content_id: string }>;
    expect(before.length).toBe(2);

    entityDelete({ id: eid });

    // After delete: zero embedding rows for those observation ids.
    const after = db
      .prepare('SELECT content_id FROM embeddings WHERE content_id IN (?, ?)')
      .all(obsId1, obsId2) as Array<{ content_id: string }>;
    expect(after.length).toBe(0);
  });
});
