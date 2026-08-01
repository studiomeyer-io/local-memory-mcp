/**
 * Learning storage with a light-weight gatekeeper.
 *
 * Gatekeeper logic (no LLM, pure SQL):
 *   1. Check for exact duplicate content → SKIP (return existing, bump usage).
 *   2. Otherwise → INSERT new.
 *
 * There deliberately is NO fuzzy "similar content → UPDATE" step. v2.4.0
 * removed it (#21): the FTS5 query OR-ed every token, bm25() is an unbounded
 * relevance score rather than a similarity, and the branch silently
 * overwrote unrelated learnings. Enriching an existing entry is explicit,
 * via memory_learn_update against a known id.
 *
 * v2.0.0+: after a successful INSERT or UPDATE we hand the content to the
 * local embedding pipeline and upsert the resulting 384-dim vector into the
 * sqlite-vec `embeddings` table. The pattern is "compute embedding outside
 * the transaction, then commit row + embedding atomically inside one
 * transaction" so a process crash between the row write and the embedding
 * write cannot leave an orphan (F4 fix from Critic R1).
 */
import { z } from 'zod';
import { getDb, newId, nowIso, escapeFtsQuery } from '../db/client.js';
import { prepareEmbedding, prepareEmbeddingBatch, writeEmbeddingSync, deleteEmbeddings, upsertEmbedding } from '../db/vector.js';
import type { ToolResult, MemoryType, LearningCategory } from '../lib/types.js';

// Re-export upsertEmbedding so existing test imports (`from './learn.js'`)
// keep working. The canonical home is `db/vector.ts` (C1 refactor from
// Analyst R1) — this alias prevents test churn for the rename.
export { upsertEmbedding };

const LEARNING_CATEGORIES: LearningCategory[] = [
  'pattern', 'mistake', 'insight', 'research', 'architecture',
  'infrastructure', 'tool', 'workflow', 'performance', 'security',
];

// ─── learn ───────────────────────────────────────────

export const learnSchema = z.object({
  category: z.enum(LEARNING_CATEGORIES as [LearningCategory, ...LearningCategory[]]),
  content: z.string().min(1).max(10000),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().optional(),
  memoryType: z.enum(['episodic', 'semantic']).optional(),
});

/**
 * Auto-classify memory type if not provided.
 * Episodic = what happened (events, incidents, "today I…").
 * Semantic = what is true (facts, rules, architecture).
 */
function classifyMemoryType(content: string, category: LearningCategory): MemoryType {
  const episodicMarkers = /\b(today|heute|yesterday|gestern|happened|passiert|incident|vorfall|just now|gerade)\b/i;
  const episodicCategories: LearningCategory[] = ['mistake'];
  if (episodicCategories.includes(category) || episodicMarkers.test(content)) {
    return 'episodic';
  }
  return 'semantic';
}

export async function learn(input: z.infer<typeof learnSchema>): Promise<ToolResult> {
  const db = getDb();

  // Gatekeeper: check for exact duplicate
  const exact = db
    .prepare('SELECT id, usage_count FROM learnings WHERE content = ? AND archived = 0 LIMIT 1')
    .get(input.content) as { id: string; usage_count: number } | undefined;

  if (exact) {
    db.prepare('UPDATE learnings SET usage_count = usage_count + 1, last_used = ? WHERE id = ?').run(
      nowIso(),
      exact.id
    );
    return {
      success: true,
      data: { id: exact.id, action: 'skipped_duplicate', usageCount: exact.usage_count + 1 },
      message: 'Duplikat erkannt — Usage-Counter erhöht.',
    };
  }

  // A "soft gatekeeper" used to sit here: an FTS5 MATCH on the first 200
  // characters, whose single best bm25() hit was overwritten when the new
  // entry was more than 50 characters longer. It was removed because it
  // destroyed unrelated learnings.
  //
  // The query was built with escapeFtsQuery, which ORs every token so that a
  // search returns rows matching ANY of them. That is right for recall and
  // wrong as the gate on a destructive write: ordinary words match almost
  // every stored row. bm25() then ranks that near-universal candidate set, and
  // because it is an unbounded, length-scaled relevance value rather than a
  // normalised similarity, the fixed -5 threshold means different things at
  // different corpus sizes. What remained of the decision was "the new entry
  // is longer".
  //
  // A near-duplicate row is a small problem. Silently replacing an unrelated
  // one is not, especially as the UPDATE rewrote only `content` and left
  // category, tags and source describing text that no longer existed.
  //
  // Exact-duplicate detection above is unaffected and still bumps usage_count.

  // Atomic insert: compute embedding outside any transaction, then INSERT row
  // + INSERT embedding in one sync transaction. Either both commit or both
  // roll back — no orphan rows on crash (F4).
  const id = newId();
  const memoryType = input.memoryType ?? classifyMemoryType(input.content, input.category);
  const vec = await prepareEmbedding(input.content);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO learnings
       (id, date, category, content, project, tags_json, confidence, source, memory_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      nowIso(),
      input.category,
      input.content,
      input.project ?? null,
      JSON.stringify(input.tags ?? []),
      input.confidence ?? 0.7,
      input.source ?? null,
      memoryType
    );
    writeEmbeddingSync(db, id, 'learning', vec);
  });
  tx();

  return {
    success: true,
    data: { id, action: 'added', memoryType },
    message: 'Learning gespeichert.',
  };
}

// ─── learn_archive (P3.3, v2.1.0) ────────────────────
//
// Marks a learning as archived. The schema has had `archived`, `archived_at`,
// and `lifecycle_state` columns since v1 — until v2.1.0 there was no tool to
// flip them, so a user who realised a stored learning was wrong had no path
// to retire it without raw SQL. Archive is a soft delete:
//
//   - the row stays in `learnings` so an asOf-style query against
//     `entity_observations` that cross-references it can still resolve.
//   - the embedding stays in `embeddings` for the same reason — cosine
//     similarity may still be useful for "find me past archived learnings
//     that looked like this new one".
//   - `recall`, `search`, and the learn-gatekeeper's similarity check all
//     filter on `archived = 0`, so archived rows never resurface as live
//     answers. The unified FTS5 trigger keeps `search_fts` in sync, so the
//     filter is the only gate.
//
// Reason is optional and stored as a "lifecycle reason" via the lifecycle_state
// column — we accept any free-form string but the canonical values are
// 'archived', 'archived:wrong', 'archived:obsolete', 'archived:superseded',
// 'archived:duplicate'. The schema doesn't constrain values, so a future
// release can extend without migration.

export const learnArchiveSchema = z.object({
  learningId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export function learnArchive(input: z.infer<typeof learnArchiveSchema>): ToolResult {
  const db = getDb();
  const existing = db
    .prepare('SELECT id, archived FROM learnings WHERE id = ?')
    .get(input.learningId) as { id: string; archived: number } | undefined;

  if (!existing) {
    return { success: false, error: 'Learning not found.', code: 'NOT_FOUND' };
  }
  if (existing.archived === 1) {
    return {
      success: true,
      data: { id: input.learningId, action: 'already_archived' },
      message: 'Learning war bereits archiviert.',
    };
  }

  // The lifecycle_state column is a free-form TEXT (default 'active'). We
  // canonicalise the archive reason as 'archived' or 'archived:<reason>' so a
  // later query can group on it. Spaces in the reason are kept; we don't
  // sanitize beyond the Zod `.max(500)` so the stored value is human-readable.
  const lifecycle = input.reason ? `archived:${input.reason}` : 'archived';

  db.prepare(
    `UPDATE learnings
       SET archived = 1,
           archived_at = ?,
           lifecycle_state = ?
     WHERE id = ?`
  ).run(nowIso(), lifecycle, input.learningId);

  return {
    success: true,
    data: { id: input.learningId, action: 'archived', lifecycleState: lifecycle },
    message: input.reason
      ? `Learning archiviert: ${input.reason}.`
      : 'Learning archiviert.',
  };
}

// ─── learn_update (P3.3, v2.1.0) ─────────────────────
//
// Edits an existing live (non-archived) learning. At least one of `content`,
// `confidence`, or `tags` must be provided. The `usage_count` is bumped and
// `last_used` is set so an update counts as a "touch".
//
// If `content` is provided AND different from the existing content, we
// re-embed. The pattern follows F4 atomicity from R1: produce the vector
// outside the transaction (because embed() is async) and then UPDATE the row
// + writeEmbeddingSync inside one sync transaction. Either both commit or
// both roll back — the row-content and the embedding can never disagree.
//
// Edge case: vector enabled but embed() fails (transient model issue). The
// new content is committed and the now-stale OLD embedding is purged via
// deleteEmbeddings so a cosine search can't return a hit on a vector that no
// longer represents the live text. The next learn() or learnUpdate() that
// succeeds will re-establish the embedding.

export const learnUpdateSchema = z.object({
  learningId: z.string().min(1),
  content: z.string().min(1).max(10000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

export async function learnUpdate(input: z.infer<typeof learnUpdateSchema>): Promise<ToolResult> {
  const db = getDb();

  if (input.content === undefined && input.confidence === undefined && input.tags === undefined) {
    return {
      success: false,
      error: 'At least one of content, confidence, or tags must be provided.',
      code: 'NOTHING_TO_UPDATE',
    };
  }

  const existing = db
    .prepare('SELECT id, content, archived FROM learnings WHERE id = ?')
    .get(input.learningId) as { id: string; content: string; archived: number } | undefined;

  if (!existing) {
    return { success: false, error: 'Learning not found.', code: 'NOT_FOUND' };
  }
  if (existing.archived === 1) {
    return {
      success: false,
      error: 'Cannot update an archived learning. Un-archive it first or create a new one.',
      code: 'ARCHIVED',
    };
  }

  // Build the SET clause from the provided fields. The usage_count + last_used
  // updates always fire so an update counts as a "touch" — that way a manual
  // edit lifts the learning out of "stale" territory the same way a recall
  // hit would.
  const updates: string[] = ['usage_count = usage_count + 1', 'last_used = ?'];
  const args: unknown[] = [nowIso()];

  const willChangeContent = input.content !== undefined && input.content !== existing.content;
  if (input.content !== undefined) {
    updates.push('content = ?');
    args.push(input.content);
  }
  if (input.confidence !== undefined) {
    updates.push('confidence = ?');
    args.push(input.confidence);
  }
  if (input.tags !== undefined) {
    updates.push('tags_json = ?');
    args.push(JSON.stringify(input.tags));
  }

  args.push(input.learningId);

  // Atomic embedding refresh. prepareEmbedding is async + safe to call when
  // vector is disabled (returns null). The writeEmbeddingSync path is the
  // F4/R2-5 atomic write — any vec0 error propagates and the row UPDATE
  // rolls back with it.
  const vec = willChangeContent ? await prepareEmbedding(input.content as string) : null;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE learnings SET ${updates.join(', ')} WHERE id = ?`).run(...args);
    if (willChangeContent) {
      if (vec) {
        writeEmbeddingSync(db, input.learningId, 'learning', vec);
      } else {
        // The content changed but we could not compute a fresh embedding (vec
        // disabled, or transient embed failure). Drop the old embedding so we
        // don't surface stale cosine matches. Cheap no-op when vec is off.
        deleteEmbeddings([input.learningId], db);
      }
    }
  });
  tx();

  return {
    success: true,
    data: {
      id: input.learningId,
      action: 'updated',
      reembedded: willChangeContent && vec !== null,
      contentChanged: willChangeContent,
    },
    message: 'Learning aktualisiert.',
  };
}

// ─── learn_bulk (v2.2.0) ─────────────────────────────
//
// Power-user batch insert. One MCP round-trip instead of N sequential
// memory_learn calls — the win is real for restoring a backup, seeding a
// fresh DB, or migrating from another memory system.
//
// Design choices (documented because they differ from single learn()):
//   - Three phases: (1) a sync pre-scan decides insert-vs-skip per item and
//     pre-generates ids for new rows; (2) ONLY the new contents are embedded,
//     in ONE batched model forward pass (prepareEmbeddingBatch) — duplicates
//     never waste an inference, and batching is the real throughput lever on a
//     CPU-only Transformers.js backend (Promise.all of single embeds would run
//     sequentially on the event loop, not in parallel); (3) one synchronous
//     transaction bumps duplicates + inserts new rows with their precomputed
//     vector.
//   - Gatekeeper is EXACT-DUPLICATE-ONLY. The interactive learn() also runs a
//     fuzzy "this looks similar, merge it" heuristic — deliberately omitted
//     here. A bulk import wants deterministic insert-or-skip, not surprise
//     merges that silently fold two distinct imported rows together.
//   - Intra-batch exact duplicates collapse: a content repeated within the same
//     batch reuses the first occurrence's pre-generated id and bumps its
//     usage_count instead of inserting twice (tracked in the pre-scan map).
//   - ATOMIC: the insert phase is one transaction. If a write throws on a
//     genuine SQLite error (busy lock, disk full, constraint) the whole batch
//     rolls back. Embedding failures do NOT throw — prepareEmbeddingBatch
//     returns null per row, so a row simply lands without a vector (FTS5 still
//     indexes it via the insert trigger).

export const learnBulkSchema = z.object({
  items: z
    .array(
      z.object({
        category: z.enum(LEARNING_CATEGORIES as [LearningCategory, ...LearningCategory[]]),
        content: z.string().min(1).max(10000),
        project: z.string().optional(),
        tags: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
        memoryType: z.enum(['episodic', 'semantic']).optional(),
      })
    )
    .min(1)
    .max(500),
});

type BulkPlan =
  | { kind: 'dup'; index: number; id: string }
  | { kind: 'new'; index: number; id: string; content: string };

export async function learnBulk(input: z.infer<typeof learnBulkSchema>): Promise<ToolResult> {
  const db = getDb();
  const exactStmt = db.prepare('SELECT id FROM learnings WHERE content = ? AND archived = 0 LIMIT 1');

  // Phase 1 (sync): decide insert-vs-skip per item BEFORE embedding so dups
  // never cost an inference. Pre-generate ids for new items and remember them
  // so an intra-batch repeat collapses onto the first occurrence.
  const plan: BulkPlan[] = [];
  const seenNew = new Map<string, string>(); // content -> pre-generated id
  for (let i = 0; i < input.items.length; i++) {
    const content = input.items[i]!.content;
    const existing = exactStmt.get(content) as { id: string } | undefined;
    if (existing) {
      plan.push({ kind: 'dup', index: i, id: existing.id });
      continue;
    }
    const seen = seenNew.get(content);
    if (seen) {
      plan.push({ kind: 'dup', index: i, id: seen });
      continue;
    }
    const id = newId();
    seenNew.set(content, id);
    plan.push({ kind: 'new', index: i, id, content });
  }

  // Phase 2 (async): embed ONLY the new contents, in one batched forward pass.
  const newPlans = plan.filter((p): p is Extract<BulkPlan, { kind: 'new' }> => p.kind === 'new');
  const vecs = await prepareEmbeddingBatch(newPlans.map((p) => p.content));
  const vecMap = new Map<string, Float32Array | null>();
  newPlans.forEach((p, i) => vecMap.set(p.id, vecs[i] ?? null));

  // Phase 3 (sync, single transaction): bump dups, insert new + embedding.
  const results: Array<{ index: number; id: string; action: 'added' | 'skipped_duplicate' }> = [];
  let added = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const p of plan) {
      if (p.kind === 'dup') {
        db.prepare('UPDATE learnings SET usage_count = usage_count + 1, last_used = ? WHERE id = ?').run(
          nowIso(),
          p.id
        );
        results.push({ index: p.index, id: p.id, action: 'skipped_duplicate' });
        skipped++;
        continue;
      }

      const it = input.items[p.index]!;
      const memoryType = it.memoryType ?? classifyMemoryType(it.content, it.category);
      db.prepare(
        `INSERT INTO learnings
         (id, date, category, content, project, tags_json, confidence, source, memory_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        p.id,
        nowIso(),
        it.category,
        it.content,
        it.project ?? null,
        JSON.stringify(it.tags ?? []),
        it.confidence ?? 0.7,
        it.source ?? null,
        memoryType
      );
      writeEmbeddingSync(db, p.id, 'learning', vecMap.get(p.id) ?? null);
      results.push({ index: p.index, id: p.id, action: 'added' });
      added++;
    }
  });
  tx();

  return {
    success: true,
    data: { total: input.items.length, added, skipped, results },
    message: `${added} Learnings hinzugefügt, ${skipped} Duplikate übersprungen.`,
  };
}

// ─── recall ──────────────────────────────────────────

// recall is the quick, FTS5-only keyword path over LEARNINGS specifically
// (memory_search is the hybrid, cross-type surface). v2.3.0 adds optional
// project/tags scoping — both columns live directly on `learnings`, so the
// filter is a cheap WHERE with no extra join. tags matches rows whose tags_json
// array contains ANY of the given tags (json_each, exact membership).
export const recallSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  project: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).min(1).optional(),
});

// Shared learnings-scope predicate for recall. `alias` is the table alias used
// in the surrounding query ('l' in the FTS join, '' for the bare-table paths).
function recallScopeClause(
  input: z.infer<typeof recallSchema>,
  alias: string
): { clause: string; args: unknown[] } {
  const col = alias ? `${alias}.` : '';
  const parts: string[] = [];
  const args: unknown[] = [];
  if (input.project !== undefined) {
    parts.push(`${col}project = ?`);
    args.push(input.project);
  }
  if (input.tags && input.tags.length > 0) {
    const ph = input.tags.map(() => '?').join(',');
    parts.push(`EXISTS (SELECT 1 FROM json_each(${col}tags_json) WHERE value IN (${ph}))`);
    args.push(...input.tags);
  }
  return { clause: parts.length > 0 ? `AND ${parts.join(' AND ')}` : '', args };
}

export function recall(input: z.infer<typeof recallSchema>): ToolResult {
  const db = getDb();
  const limit = input.limit ?? 20;

  if (!input.query || input.query.trim().length === 0) {
    // No query → return most recent learnings
    const scope = recallScopeClause(input, '');
    const rows = db
      .prepare(
        `SELECT id, date, category, content, project, confidence, memory_type
         FROM learnings
         WHERE archived = 0
         ${scope.clause}
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(...scope.args, limit);
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  }

  // FTS5 search
  try {
    const fts = escapeFtsQuery(input.query);
    const scope = recallScopeClause(input, 'l');
    const rows = db
      .prepare(
        `SELECT l.id, l.date, l.category, l.content, l.project, l.confidence, l.memory_type,
                bm25(search_fts) AS rank
         FROM search_fts
         JOIN learnings l ON l.id = search_fts.content_id
         WHERE search_fts MATCH ? AND search_fts.content_type = 'learning'
         AND l.archived = 0
         ${scope.clause}
         ORDER BY rank
         LIMIT ?`
      )
      .all(fts, ...scope.args, limit);
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  } catch {
    // Fallback to LIKE if FTS query parsing fails
    const scope = recallScopeClause(input, '');
    const rows = db
      .prepare(
        `SELECT id, date, category, content, project, confidence, memory_type
         FROM learnings
         WHERE content LIKE ? AND archived = 0
         ${scope.clause}
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(`%${input.query}%`, ...scope.args, limit);
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  }
}
