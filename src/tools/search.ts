/**
 * Unified search across learnings, decisions, entities, and observations.
 *
 * v1 uses FTS5 only (keyword + bm25 ranking). Semantic search is planned for v2
 * via fastembed-rs — but FTS5 already handles the common case well.
 */
import { z } from 'zod';
import { getDb, escapeFtsQuery } from '../db/client.js';
import type { ToolResult } from '../lib/types.js';

export const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  types: z.array(z.enum(['learning', 'decision', 'entity', 'observation'])).optional(),
});

export function search(input: z.infer<typeof searchSchema>): ToolResult {
  const db = getDb();
  const limit = input.limit ?? 20;

  try {
    const fts = escapeFtsQuery(input.query);

    const typeFilter =
      input.types && input.types.length > 0
        ? `AND search_fts.content_type IN (${input.types.map(() => '?').join(',')})`
        : '';

    const sql = `
      SELECT content_id AS id,
             content_type AS type,
             title,
             body,
             bm25(search_fts) AS rank
      FROM search_fts
      WHERE search_fts MATCH ? ${typeFilter}
      ORDER BY rank
      LIMIT ?
    `;

    const args: unknown[] = [fts];
    if (input.types && input.types.length > 0) args.push(...input.types);
    args.push(limit);

    const rows = db.prepare(sql).all(...args) as Array<{
      id: string;
      type: string;
      title: string;
      body: string;
      rank: number;
    }>;

    // Strip archived learnings (FTS5 doesn't know about the archived flag)
    const archivedIds = new Set(
      (db
        .prepare('SELECT id FROM learnings WHERE archived = 1')
        .all() as Array<{ id: string }>).map((r) => r.id)
    );
    const filtered = rows.filter((r) => !(r.type === 'learning' && archivedIds.has(r.id)));

    return {
      success: true,
      data: {
        query: input.query,
        results: filtered,
        count: filtered.length,
      },
      message: `${filtered.length} Ergebnisse für "${input.query}".`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Suchfehler: ${err instanceof Error ? err.message : String(err)}`,
      code: 'SEARCH_FAILED',
    };
  }
}
