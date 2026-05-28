/**
 * sqlite-vec extension loader + embedding storage layer.
 *
 * `loadVecExtension` is best-effort. On a platform where sqlite-vec ships a
 * prebuilt binary that matches the better-sqlite3 ABI (linux-x64, darwin-x64,
 * darwin-arm64, win32-x64 today) the load succeeds and we get a `vec0`
 * virtual table type that supports KNN MATCH queries against `Float32Array`
 * inputs. On any other platform — or if the dynamic loader is blocked — we
 * stay in FTS5-only mode and `isVectorEnabled()` returns false for the
 * lifetime of the process.
 *
 * Power-user opt-out: setting `MEMORY_REQUIRE_VEC=1` flips the loader from
 * "swallow and degrade" to "crash loud" — useful for users who would rather
 * see a startup error than silently lose semantic recall.
 *
 * The contract for callers (search.ts, learn.ts, decide.ts, entity.ts):
 *   - call `loadVecExtension(db)` exactly once, right after schema bootstrap
 *   - check `isVectorEnabled()` before touching the `embeddings` virtual table
 *   - use `upsertEmbedding()` to write an embedding for a row in another table
 *   - use `deleteEmbeddings()` to clean up after deleting source rows
 *   - never crash if a vec query fails; fall through to the FTS5 path
 */
import type { Database } from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { embed, EMBEDDING_DIM, embedModelId } from '../lib/embed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let vectorEnabled = false;
let lastError: string | null = null;

/**
 * Try to load the sqlite-vec extension into this Database.
 *
 * IMPORTANT: this MUST run once per Database handle. The `vec0` virtual table
 * type is registered against an open SQLite connection by
 * `db.loadExtension()`. A fresh connection (e.g. tests opening a new tmp
 * SQLite per case) starts without vec0 even though the npm package is
 * already loaded into the Node process. Caching "we loaded once → return
 * true forever" would lie about a fresh handle, and the follow-up
 * `CREATE VIRTUAL TABLE … USING vec0` would fail with "no such module:
 * vec0". So we run the load every time we get a new Database in, and
 * `closeDb()` resets the module-level mirror via `_resetForTests()` so
 * other helpers (`isVectorEnabled`, `vectorStatus`) reflect the live state.
 *
 * F2 hardening (Critic R1 + Research R1): if `MEMORY_REQUIRE_VEC=1` is set
 * we rethrow the load failure as a fatal error so the user sees the crash
 * instead of a silent FTS5-only mode. Useful for power-users on platforms
 * where they expect vec to be present (and would rather notice during boot
 * than during a search).
 *
 * Returns true if vec is now usable on this connection.
 */
export function loadVecExtension(db: Database): boolean {
  try {
    // The sqlite-vec npm package exposes a `load(db)` helper that finds the
    // right native binary inside its own node_modules and calls
    // db.loadExtension under the hood. We import dynamically so a missing
    // package or ABI mismatch never crashes the server.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec') as { load: (db: Database) => void };
    sqliteVec.load(db);
    vectorEnabled = true;
    lastError = null;
    logger.info('[vector] sqlite-vec extension loaded');
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    vectorEnabled = false;
    if (process.env.MEMORY_REQUIRE_VEC === '1') {
      // Loud failure path — let the caller crash. Useful for CI integration
      // tests and for users on platforms that must support vec.
      process.stderr.write(
        `[local-memory] FATAL: sqlite-vec failed to load on ${process.platform}-${process.arch}-node${process.version} and MEMORY_REQUIRE_VEC=1 was set: ${lastError}\n`
      );
      throw err instanceof Error ? err : new Error(lastError);
    }
    logger.warn(`[vector] sqlite-vec unavailable, FTS5-only mode: ${lastError}`);
    return false;
  }
}

/**
 * After loadVecExtension succeeds, apply the embeddings VIRTUAL TABLE
 * migration. Safe to call multiple times — `CREATE VIRTUAL TABLE IF NOT
 * EXISTS` is a no-op when the table is already there. Returns true if the
 * embeddings table exists after this call.
 *
 * F7 hardening (Critic R1): after the migration runs we cross-check the
 * meta-table fingerprint (`embedding_dim`, `embedding_model`) against the
 * runtime configuration. If the dims don't match (e.g. a user swapped to a
 * 768-dim model) we disable vec for this run so we never silently truncate
 * vectors into the wrong space. Model-name mismatches log a warning but
 * don't disable — same dims with a different model is a soft case where
 * cosine similarity is still meaningful, just not optimal.
 */
export function applyVectorSchema(db: Database): boolean {
  if (!vectorEnabled) return false;

  // The migration file ships alongside the compiled output. In dev mode
  // we read from src/db/migrations; in dist we read from dist/db/migrations.
  // Both paths exist relative to __dirname (`db/`).
  const candidates = [
    join(__dirname, 'migrations', '002_vector.sql'),
    join(__dirname, '..', '..', 'src', 'db', 'migrations', '002_vector.sql'),
  ];
  const migrationPath = candidates.find((p) => existsSync(p));
  if (!migrationPath) {
    lastError = 'migration file 002_vector.sql not found';
    logger.warn(`[vector] ${lastError}`);
    vectorEnabled = false;
    return false;
  }

  // R2-1 fix (Critic R2): the F7 fingerprint check has to read the OLD
  // `embedding_model` meta value BEFORE the migration runs, because
  // 002_vector.sql contains `INSERT OR REPLACE INTO meta (key, value)
  // VALUES ('embedding_model', 'Xenova/multilingual-e5-small')`. If we read
  // after, the meta value already equals the runtime default and the drift
  // signal is gone forever. So we snapshot first, run the migration, then
  // compare the snapshot to `embedModelId()`.
  let priorModel: string | null = null;
  let priorRowCount = 0;
  try {
    const m = db
      .prepare("SELECT value FROM meta WHERE key = 'embedding_model'")
      .get() as { value: string } | undefined;
    priorModel = m?.value ?? null;
    // The embeddings table may not exist yet on a v1 DB — defensive count.
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings' LIMIT 1")
      .get();
    if (tbl) {
      const c = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number } | undefined;
      priorRowCount = c?.c ?? 0;
    }
  } catch {
    // Snapshot is best-effort. A failure here just means we won't be able
    // to warn about drift; the migration itself can still proceed.
  }

  try {
    const sql = readFileSync(migrationPath, 'utf-8');
    db.exec(sql);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn(`[vector] schema migration failed: ${lastError}`);
    // If the migration fails (e.g. an existing DB has a conflicting
    // embeddings table from an aborted upgrade), disable vec for this run.
    vectorEnabled = false;
    return false;
  }

  // F7 + R2-1: warn about model drift using the snapshot. Same-dim
  // cross-model is logged only (cosine still meaningful, just not optimal).
  // Dim mismatch is enforced by vec0 itself — the embeddings VIRTUAL TABLE
  // was created with float[EMBEDDING_DIM] so any INSERT of a wrong-length
  // vector throws SqliteError; `writeEmbeddingSync` lets that propagate.
  if (priorModel && priorRowCount > 0 && priorModel !== embedModelId()) {
    logger.warn(
      `[vector] embedding model fingerprint drift: ${priorRowCount} existing rows were produced with "${priorModel}", runtime model is now "${embedModelId()}". ` +
        `Cosine similarity may degrade. To rebuild, set MEMORY_EMBED_MODEL back or wipe embeddings: DELETE FROM embeddings.`
    );
  }
  return true;
}

export function isVectorEnabled(): boolean {
  return vectorEnabled;
}

export function vectorStatus(): { enabled: boolean; error: string | null } {
  return { enabled: vectorEnabled, error: lastError };
}

/**
 * Embedding storage — upsert + cascade helpers.
 *
 * `upsertEmbedding` is the single public write path for vectors. It computes
 * the embedding outside any DB transaction (so the async work doesn't hold
 * write locks), then writes DELETE+INSERT inside one synchronous transaction
 * because vec0 doesn't honour INSERT OR REPLACE on its primary key. The
 * outer caller can wrap this in its own atomic insert+embed transaction to
 * ensure FTS row + embedding row commit together; see `learn.ts`/`decide.ts`/
 * `entity.ts` for the pattern.
 *
 * C1 Refactor (Analyst R1): moved here from `tools/learn.ts` because it is
 * infrastructure shared by three tool modules (`learn`, `decide`,
 * `entityObserve`). Living in the db layer matches the dependency direction
 * `tools/* → db/* → lib/*`.
 *
 * F10 cleanup (Critic R1): removed the dead `'entity'` arm from the
 * contentType union since entities themselves are not embedded — only their
 * observations are. The single source of truth for "what is embedded" is now
 * the union itself.
 *
 * R2-7 doc-strengthen (Critic R2): the DB column is just a TEXT aux column
 * with no constraint, so a raw-SQL caller could write any string into it.
 * Do NOT extend this union — entity-level embedding is intentionally not
 * supported because entity rows carry only a name+summary while their
 * attached observations carry the semantic surface. If you need entity
 * recall, embed the observations.
 */
export type EmbeddingContentType = 'learning' | 'decision' | 'observation';

/**
 * @deprecated Since v2.0.0 R2 — prefer `prepareEmbedding` + `writeEmbeddingSync`
 * inside the caller's own `db.transaction()`. This standalone path does the
 * embedding write outside the caller's row INSERT transaction, which makes it
 * impossible to roll back together if anything fails. The helper is kept
 * exported because a small surface of tests still imports it under its old
 * name. New code MUST use the atomic two-step pattern; see learn.ts for the
 * reference implementation.
 */
export async function upsertEmbedding(
  contentId: string,
  contentType: EmbeddingContentType,
  text: string,
): Promise<void> {
  if (!vectorEnabled) return;
  let vec: Float32Array | null;
  try {
    vec = await embed(text);
  } catch (err) {
    logger.warn(`[vector] embed() threw for ${contentType}:${contentId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!vec || vec.length !== EMBEDDING_DIM) return;
  try {
    // Dynamic getDb import to avoid a cycle with client.ts (client imports
    // vector for loadVecExtension; we'd otherwise have a circular import).
    const { getDb } = await import('./client.js');
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM embeddings WHERE content_id = ?').run(contentId);
      db.prepare(
        `INSERT INTO embeddings (content_id, content_type, embedding)
         VALUES (?, ?, ?)`
      ).run(contentId, contentType, vec);
    });
    tx();
  } catch (err) {
    logger.warn(`[vector] embedding upsert failed for ${contentType}:${contentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Two-step atomic write helpers — produce the vector outside any transaction
 * (because embed() is async), then write the embedding row inside the
 * caller's transaction (which is synchronous in better-sqlite3) so the
 * source row insert and the embedding insert commit together.
 *
 * F4 fix (Critic R1): the previous pattern was
 *   db.prepare(INSERT row).run(...)        // commit 1
 *   await upsertEmbedding(id, …)           // separate commit
 * which left an orphan source row if the process crashed in between. The
 * atomic pattern is now:
 *   const vec = await prepareEmbedding(text);     // async, no tx
 *   db.transaction(() => {
 *     db.prepare(INSERT row).run(...);
 *     writeEmbeddingSync(db, id, type, vec);
 *   })();
 * Either both succeed or both roll back. Callers in learn.ts / decide.ts /
 * entity.ts use this shape.
 */
export async function prepareEmbedding(text: string): Promise<Float32Array | null> {
  if (!vectorEnabled) return null;
  try {
    const vec = await embed(text);
    if (!vec || vec.length !== EMBEDDING_DIM) return null;
    return vec;
  } catch (err) {
    logger.warn(`[vector] prepareEmbedding failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Write a precomputed embedding to the vec0 table, inside the caller's
 * transaction. Strict atomicity: any SqliteError thrown by vec0 (busy lock,
 * dim mismatch, full disk) propagates out so the enclosing `db.transaction`
 * wrapper rolls back the source-row INSERT too. The caller (learn.ts /
 * decide.ts / entity.ts) does NOT catch this — a failed embedding write is
 * treated as a failed write, period.
 *
 * R2-5 fix (Critic R2): the previous version caught the error and emitted a
 * `logger.warn`. That left the outer transaction unaware, the source row
 * committed, and the embedding silently absent. That broke the F4 atomicity
 * guarantee in the error path. Now the error propagates and the whole
 * write rolls back.
 *
 * Behaviour summary:
 *   - `vectorEnabled === false` → no-op (vec not loaded on this platform).
 *   - `vec === null` → no-op (caller decided not to embed this row).
 *   - SQLite error during DELETE or INSERT → thrown, transaction rolls back.
 */
export function writeEmbeddingSync(
  db: Database,
  contentId: string,
  contentType: EmbeddingContentType,
  vec: Float32Array | null,
): void {
  if (!vectorEnabled || !vec) return;
  db.prepare('DELETE FROM embeddings WHERE content_id = ?').run(contentId);
  db.prepare(
    `INSERT INTO embeddings (content_id, content_type, embedding)
     VALUES (?, ?, ?)`
  ).run(contentId, contentType, vec);
}

/**
 * Cascade delete embeddings whose content_id matches any of the given ids.
 * Used by entity delete paths so vector-only ghost rows don't accumulate
 * after an entity (and its observations) are removed.
 *
 * F3 fix (Critic R1): observations were previously deleted from the source
 * table without their embedding rows being cleaned up. Over time those ghost
 * embeddings were unreachable via FTS join but still consumed disk + index
 * slots. This helper closes the leak.
 *
 * Safe no-op when vec isn't enabled.
 */
export function deleteEmbeddings(contentIds: string[], db: Database): void {
  if (!vectorEnabled || contentIds.length === 0) return;
  try {
    const placeholders = contentIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM embeddings WHERE content_id IN (${placeholders})`).run(...contentIds);
  } catch (err) {
    logger.warn(`[vector] cascade delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Test helper: reset state between cases. Production callers should never use this.
 */
export function _resetForTests(): void {
  vectorEnabled = false;
  lastError = null;
}
