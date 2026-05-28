/**
 * Learning storage with a light-weight gatekeeper.
 *
 * Gatekeeper logic (no LLM, pure SQL):
 *   1. Check for exact duplicate content → SKIP (return existing).
 *   2. Check for very similar content via FTS5 + length heuristic → UPDATE existing.
 *   3. Otherwise → INSERT new.
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
import { prepareEmbedding, writeEmbeddingSync, deleteEmbeddings, upsertEmbedding } from '../db/vector.js';
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

  // Soft gatekeeper: FTS5 similarity check
  try {
    const fts = escapeFtsQuery(input.content.slice(0, 200));
    const similar = db
      .prepare(
        `SELECT l.id, l.content, l.usage_count,
                bm25(search_fts) AS score
         FROM search_fts
         JOIN learnings l ON l.id = search_fts.content_id
         WHERE search_fts MATCH ? AND search_fts.content_type = 'learning'
         AND l.archived = 0
         ORDER BY score
         LIMIT 1`
      )
      .get(fts) as { id: string; content: string; usage_count: number; score: number } | undefined;

    // If the top match is very short and the new input is long, OR vice versa,
    // treat as UPDATE (new, richer version of the same learning).
    if (similar && similar.score < -5) {
      const lenDiff = Math.abs(similar.content.length - input.content.length);
      if (lenDiff > 50 && input.content.length > similar.content.length) {
        // Atomic update: compute the new embedding outside the transaction,
        // then UPDATE the row + write the embedding in one sync transaction.
        const vec = await prepareEmbedding(input.content);
        const tx = db.transaction(() => {
          db.prepare(
            'UPDATE learnings SET content = ?, usage_count = usage_count + 1, last_used = ?, confidence = ? WHERE id = ?'
          ).run(input.content, nowIso(), input.confidence ?? 0.7, similar.id);
          writeEmbeddingSync(db, similar.id, 'learning', vec);
        });
        tx();
        return {
          success: true,
          data: { id: similar.id, action: 'updated_similar', usageCount: similar.usage_count + 1 },
          message: 'Ähnliches Learning erweitert.',
        };
      }
    }
  } catch (err) {
    // FTS5 query parsing failed — not fatal, just skip the similarity check.
    // Log for debugging but continue with insert.
    process.stderr.write(`[local-memory] FTS5 similarity check failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

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

// ─── recall ──────────────────────────────────────────

export const recallSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function recall(input: z.infer<typeof recallSchema>): ToolResult {
  const db = getDb();
  const limit = input.limit ?? 20;

  if (!input.query || input.query.trim().length === 0) {
    // No query → return most recent learnings
    const rows = db
      .prepare(
        `SELECT id, date, category, content, project, confidence, memory_type
         FROM learnings
         WHERE archived = 0
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(limit);
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  }

  // FTS5 search
  try {
    const fts = escapeFtsQuery(input.query);
    const rows = db
      .prepare(
        `SELECT l.id, l.date, l.category, l.content, l.project, l.confidence, l.memory_type,
                bm25(search_fts) AS rank
         FROM search_fts
         JOIN learnings l ON l.id = search_fts.content_id
         WHERE search_fts MATCH ? AND search_fts.content_type = 'learning'
         AND l.archived = 0
         ORDER BY rank
         LIMIT ?`
      )
      .all(fts, limit);
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  } catch {
    // Fallback to LIKE if FTS query parsing fails
    const rows = db
      .prepare(
        `SELECT id, date, category, content, project, confidence, memory_type
         FROM learnings
         WHERE content LIKE ? AND archived = 0
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(`%${input.query}%`, limit);
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  }
}
