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
    const obs = entityObserve({ entityId: id, content: 'Disk at 77%' });
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
    const obs = entityObserve({
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
    const obs = entityObserve({ content: 'orphan' });
    expect(obs.success).toBe(false);
    if (!obs.success) {
      expect(obs.code).toBe('MISSING_ENTITY_REF');
    }
  });

  it('fails with MISSING_ENTITY_REF when only name is passed without type', async () => {
    const { entityObserve } = await import('./entity.js');
    const obs = entityObserve({ entityName: 'Foo', content: 'hi' });
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

    entityObserve({ entityId: id, content: 'new fact' });

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
    const obs = entityObserve({
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
    entityObserve({ entityId: (created.data as { id: string }).id, content: 'runs on kubernetes' });
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
    entityObserve({ entityId: aid, content: 'obs one' });
    entityObserve({ entityId: aid, content: 'obs two' });
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
    entityObserve({ entityId: id, content: 'active fact' });
    entityObserve({ entityId: id, content: 'retired fact' });

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

  it('FTS index stays consistent when an observation content is updated (obs_au trigger)', async () => {
    // The observation table has ai/ad triggers; obs_au was added so a future
    // "edit observation" path doesn't leave stale rows in search_fts pointing
    // at the old content. We exercise it directly with an UPDATE here.
    const { entityCreate, entityObserve, entitySearch } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const created = entityCreate({ name: 'TriggerHost', entityType: 'project' });
    if (!created.success) throw new Error('setup failed');
    const eid = (created.data as { id: string }).id;
    const obs = entityObserve({ entityId: eid, content: 'original text with snowleopard' });
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
    entityObserve({ entityId: aid, content: 'will vanish' });
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
});
