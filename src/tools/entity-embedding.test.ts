/**
 * Tests for the v2.3.0 entity-embedding bugfix.
 *
 * Before this fix, memory_search({mode:'vector', types:['entity']}) ALWAYS
 * returned 0 because entities were never embedded, even though searchSchema
 * advertised 'entity' in its types enum — a silent capability lie. These tests
 * prove entities now embed on create/observe, that vector search surfaces them,
 * that the write stays atomic (row + vector commit together), and that the boot
 * backfill picks up legacy (pre-fix) entity rows.
 *
 * All require sqlite-vec (vector mode). They no-op on platforms without it.
 * Runs under MEMORY_EMBED_MOCK=1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-entemb-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('entity embedding — vector search over entities (the bugfix)', () => {
  it('memory_search({mode:"vector", types:["entity"]}) returns an entity (was always 0)', async () => {
    const { entityCreateEmbedded } = await import('./entity.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = await entityCreateEmbedded({
      name: 'Helios',
      entityType: 'project',
      summary: 'solar telemetry platform',
    });
    expect(created.success).toBe(true);

    const r = await search({ query: 'Helios', mode: 'vector', types: ['entity'] });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ id: string; type: string }>; count: number; mode: string };
      expect(d.mode).toBe('vector');
      expect(d.count).toBeGreaterThan(0);
      expect(d.results.every((x) => x.type === 'entity')).toBe(true);
      expect(d.results[0]?.id).toBe((created.data as { id: string }).id);
    }
  });

  it('writes exactly one embeddings row of content_type=entity on create', async () => {
    const { entityCreateEmbedded } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const created = await entityCreateEmbedded({ name: 'Vesta', entityType: 'tool' });
    if (!created.success) throw new Error('setup failed');
    const id = (created.data as { id: string }).id;

    const cnt = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE content_id = ? AND content_type = 'entity'")
      .get(id) as { c: number }).c;
    expect(cnt).toBe(1);
  });

  it('entityObserve auto-creates an entity that is itself vector-searchable', async () => {
    const { entityObserve } = await import('./entity.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const obs = await entityObserve({ entityName: 'Ceres', entityType: 'project', content: 'mapping survey' });
    if (!obs.success) throw new Error('observe failed');
    const entityId = (obs.data as { entityId: string }).entityId;

    // The auto-created entity has its own embedding row.
    const cnt = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE content_id = ? AND content_type = 'entity'")
      .get(entityId) as { c: number }).c;
    expect(cnt).toBe(1);
  });

  it('atomicity: a failed entity embedding write rolls back the entity row', async () => {
    // Force the embedding INSERT to throw by writing a wrong-dim vector. The F4
    // contract says writeEmbeddingSync lets the SqliteError propagate so the
    // enclosing transaction rolls back the entity row INSERT too — no orphan.
    // We exercise the shared internal path via entityCreateEmbedded but inject
    // the failure by monkeypatching the embed pipeline to return a bad vector.
    const embedMod = await import('../lib/embed.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const { entityCreateInternalForTest } = await import('./entity.js');

    // A 7-dim vector is the wrong length for the float[384] vec0 column → INSERT
    // throws inside the transaction.
    const badVec = new Float32Array(7);
    badVec[0] = 1;

    const before = (getDb().prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c;
    let threw = false;
    try {
      entityCreateInternalForTest({ name: 'Phobos', entityType: 'moon' }, badVec);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const after = (getDb().prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c;
    // Row count unchanged → the entity INSERT rolled back with the bad embedding.
    expect(after).toBe(before);
    // And no entity named Phobos exists.
    const ph = getDb().prepare('SELECT id FROM entities WHERE name = ?').get('Phobos');
    expect(ph).toBeUndefined();
    void embedMod; // imported for parity with sibling tests; not otherwise used.
  });

  it('refreshes the entity embedding when an existing entity gets a new summary', async () => {
    const { entityCreateEmbedded } = await import('./entity.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    // Create without summary, then re-create with a distinctive summary token.
    const first = await entityCreateEmbedded({ name: 'Pallas', entityType: 'concept' });
    if (!first.success) throw new Error('setup failed');
    await entityCreateEmbedded({ name: 'Pallas', entityType: 'concept', summary: 'cryptographic ratchet design' });

    // The summary token now participates in the entity vector.
    const r = await search({ query: 'cryptographic ratchet', mode: 'vector', types: ['entity'] });
    if (r.success) {
      const d = r.data as { results: Array<{ id: string }>; count: number };
      expect(d.count).toBeGreaterThan(0);
      expect(d.results.some((x) => x.id === (first.data as { id: string }).id)).toBe(true);
    }
  });

  it('backfillEntityEmbeddings embeds legacy entity rows created without a vector', async () => {
    const { entityCreate } = await import('./entity.js');
    const { backfillEntityEmbeddings, isVectorEnabled } = await import('../db/vector.js');
    const { getDb } = await import('../db/client.js');
    if (!isVectorEnabled()) return;

    // The SYNC entityCreate writes the row but no embedding — exactly the
    // pre-v2.3.0 legacy shape.
    const created = entityCreate({ name: 'Juno', entityType: 'project', summary: 'asteroid orbiter' });
    if (!created.success) throw new Error('setup failed');
    const id = (created.data as { id: string }).id;

    const before = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE content_id = ?")
      .get(id) as { c: number }).c;
    expect(before).toBe(0);

    const n = await backfillEntityEmbeddings(getDb());
    expect(n).toBeGreaterThanOrEqual(1);

    const after = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE content_id = ? AND content_type = 'entity'")
      .get(id) as { c: number }).c;
    expect(after).toBe(1);

    // A second backfill is a no-op (idempotent) — the row already has a vector.
    const n2 = await backfillEntityEmbeddings(getDb());
    expect(n2).toBe(0);
  });
});
