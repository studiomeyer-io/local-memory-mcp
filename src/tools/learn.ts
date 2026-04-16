/**
 * Learning storage with a light-weight gatekeeper.
 *
 * Gatekeeper logic (no LLM, pure SQL):
 *   1. Check for exact duplicate content → SKIP (return existing).
 *   2. Check for very similar content via FTS5 + length heuristic → UPDATE existing.
 *   3. Otherwise → INSERT new.
 */
import { z } from 'zod';
import { getDb, newId, nowIso, escapeFtsQuery } from '../db/client.js';
import type { ToolResult, MemoryType, LearningCategory } from '../lib/types.js';

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

export function learn(input: z.infer<typeof learnSchema>): ToolResult {
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
        db.prepare(
          'UPDATE learnings SET content = ?, usage_count = usage_count + 1, last_used = ?, confidence = ? WHERE id = ?'
        ).run(input.content, nowIso(), input.confidence ?? 0.7, similar.id);
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

  // Insert new
  const id = newId();
  const memoryType = input.memoryType ?? classifyMemoryType(input.content, input.category);

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

  return {
    success: true,
    data: { id, action: 'added', memoryType },
    message: 'Learning gespeichert.',
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
