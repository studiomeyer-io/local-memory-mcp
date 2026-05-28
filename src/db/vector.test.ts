/**
 * Tests for the sqlite-vec loader + embeddings virtual table.
 *
 * These exercise the full path getDb → loadVecExtension → applyVectorSchema
 * against a real tmp SQLite file so the integration that broke in early
 * v2.0.0 (KNN filter on aux column, stale vectorEnabled cache between test
 * cases) stays fixed.
 *
 * When sqlite-vec can't load on the runner (e.g. an exotic platform) we
 * skip silently — `isVectorEnabled()` returning false is itself a tested
 * contract. Hybrid search degrades to FTS5 in that case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-vector-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('./client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('sqlite-vec loader', () => {
  it('loads on supported platforms and exposes the embeddings table', async () => {
    const { getDb } = await import('./client.js');
    const { isVectorEnabled } = await import('./vector.js');
    const db = getDb();
    if (!isVectorEnabled()) {
      // Platform without prebuilt binary — the rest of the test would fail
      // pointlessly. The fallback is intentional and covered elsewhere.
      return;
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='shadow' OR type='virtual' ORDER BY name")
      .all() as Array<{ name: string }>;
    // The vec0 virtual table appears as the user-facing name plus a couple of
    // shadow tables (_rowids, _chunks). Existence of at least one of them
    // proves the migration ran.
    expect(tables.some((t) => t.name.startsWith('embeddings'))).toBe(true);
  });

  it('vectorStatus reports enabled=true and clears any stale error', async () => {
    const { getDb } = await import('./client.js');
    const { isVectorEnabled, vectorStatus } = await import('./vector.js');
    getDb();
    if (!isVectorEnabled()) return;
    const status = vectorStatus();
    expect(status.enabled).toBe(true);
    expect(status.error).toBeNull();
  });

  it('reloads the extension cleanly after closeDb (no stale-cache bug)', async () => {
    // This is the regression guard for the early-v2 bug where vectorEnabled
    // stayed true across closeDb(), the next getDb() skipped the load, and
    // CREATE VIRTUAL TABLE failed with "no such module: vec0".
    const { getDb, closeDb } = await import('./client.js');
    const { isVectorEnabled } = await import('./vector.js');
    getDb();
    const wasEnabled = isVectorEnabled();
    closeDb();
    // After closeDb the mirror state is reset to false.
    expect(isVectorEnabled()).toBe(false);
    // Opening a fresh DB re-runs the load and lands on the same status.
    getDb();
    expect(isVectorEnabled()).toBe(wasEnabled);
  });
});

describe('embeddings VIRTUAL TABLE', () => {
  it('accepts INSERT + KNN MATCH against a Float32Array vector', async () => {
    const { getDb } = await import('./client.js');
    const { isVectorEnabled } = await import('./vector.js');
    const { mockEmbed } = await import('../lib/embed.js');
    const db = getDb();
    if (!isVectorEnabled()) return;

    const v1 = mockEmbed('banana yellow fruit');
    const v2 = mockEmbed('apple red fruit');
    const v3 = mockEmbed('mediterranean diet olive oil');
    db.prepare('INSERT INTO embeddings (content_id, content_type, embedding) VALUES (?, ?, ?)').run('a', 'learning', v1);
    db.prepare('INSERT INTO embeddings (content_id, content_type, embedding) VALUES (?, ?, ?)').run('b', 'learning', v2);
    db.prepare('INSERT INTO embeddings (content_id, content_type, embedding) VALUES (?, ?, ?)').run('c', 'learning', v3);

    // KNN MATCH against the banana vector should rank banana itself first,
    // apple second (shares "fruit"), and the olive-oil row last.
    const rows = db.prepare(`
      SELECT content_id, distance
      FROM embeddings
      WHERE embedding MATCH ? AND k = 3
      ORDER BY distance
    `).all(mockEmbed('banana yellow fruit')) as Array<{ content_id: string; distance: number }>;

    expect(rows.length).toBe(3);
    expect(rows[0]?.content_id).toBe('a');
    // The other two can flip but both must rank behind the self-match.
    expect(rows[0]?.distance).toBeLessThan(rows[1]?.distance ?? 0);
  });

  it('DELETE-then-INSERT replaces a vector keyed on content_id', async () => {
    // vec0 doesn't honour INSERT OR REPLACE on its PRIMARY KEY, so we model
    // upsert with an explicit DELETE+INSERT pair (see upsertEmbedding in
    // src/tools/learn.ts). This test pins that contract.
    const { getDb } = await import('./client.js');
    const { isVectorEnabled } = await import('./vector.js');
    const { mockEmbed } = await import('../lib/embed.js');
    const db = getDb();
    if (!isVectorEnabled()) return;

    db.prepare('INSERT INTO embeddings (content_id, content_type, embedding) VALUES (?, ?, ?)').run(
      'x', 'learning', mockEmbed('first version of this learning')
    );
    db.prepare('DELETE FROM embeddings WHERE content_id = ?').run('x');
    db.prepare('INSERT INTO embeddings (content_id, content_type, embedding) VALUES (?, ?, ?)').run(
      'x', 'learning', mockEmbed('updated text replaces the old vector')
    );
    const count = (db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('upsertEmbedding survives being called twice on the same content_id', async () => {
    // Direct regression guard for the gatekeeper's "updated_similar" branch
    // in learn.ts — that branch can re-embed the same learning id with new
    // text. Without the DELETE-first upsert, the second call would throw
    // SqliteError: UNIQUE constraint failed.
    const { getDb } = await import('./client.js');
    const { isVectorEnabled } = await import('./vector.js');
    const { upsertEmbedding } = await import('../tools/learn.js');
    const db = getDb();
    if (!isVectorEnabled()) return;

    await upsertEmbedding('upsert-id', 'learning', 'first version of the content');
    await upsertEmbedding('upsert-id', 'learning', 'second version replaces the first');

    const rows = db.prepare('SELECT content_id FROM embeddings WHERE content_id = ?').all('upsert-id') as Array<{ content_id: string }>;
    expect(rows.length).toBe(1);
  });

  it('R2-5 fix: writeEmbeddingSync error rolls back the source-row INSERT (atomicity)', async () => {
    // R2-5 regression guard (Critic R2): if vec0 throws during the embedding
    // write, the enclosing db.transaction() must roll back the source row
    // too. Previously writeEmbeddingSync caught its own error, so the source
    // row committed alone — breaking F4 atomicity in the error path.
    // We simulate the failure by trying to write a wrong-dim vector inside
    // a transaction that also inserts a learning row, then assert that the
    // learning row is NOT present after the transaction throws.
    const { getDb } = await import('./client.js');
    const { isVectorEnabled, writeEmbeddingSync } = await import('./vector.js');
    const db = getDb();
    if (!isVectorEnabled()) return;

    const wrongDimVec = new Float32Array(128); // dim 128, schema expects 384

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO learnings
         (id, date, category, content, project, tags_json, confidence, source, memory_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('atomic-fail-id', new Date().toISOString(), 'pattern', 'should rollback', null, '[]', 0.7, null, 'semantic');
      // The cast through unknown silences the static-type guard so we can
      // exercise the runtime invariant — vec0 enforces dim at INSERT time.
      writeEmbeddingSync(db, 'atomic-fail-id', 'learning', wrongDimVec as unknown as Float32Array);
    });

    expect(() => tx()).toThrow();

    // Source row was rolled back — F4 atomicity invariant holds.
    const orphan = db
      .prepare('SELECT id FROM learnings WHERE id = ?')
      .get('atomic-fail-id') as { id: string } | undefined;
    expect(orphan).toBeUndefined();
  });

  it('schema_version is bumped to 2 once the migration runs', async () => {
    const { getDb } = await import('./client.js');
    const { isVectorEnabled } = await import('./vector.js');
    const db = getDb();
    if (!isVectorEnabled()) return;
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(row?.value).toBe('2');
  });

  it('embedding_model fingerprint is stored in meta', async () => {
    const { getDb } = await import('./client.js');
    const { isVectorEnabled } = await import('./vector.js');
    const db = getDb();
    if (!isVectorEnabled()) return;
    const row = db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get() as { value: string };
    expect(row?.value).toBe('Xenova/multilingual-e5-small');
  });
});
