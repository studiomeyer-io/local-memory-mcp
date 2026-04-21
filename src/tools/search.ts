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

    // Archived learnings are filtered at the SQL level via LEFT JOIN so the
    // LIMIT applies to the post-filter set. The previous implementation
    // pulled every match, fetched every archived-learning id separately, and
    // filtered in memory — which broke LIMIT semantics whenever the top-N
    // hits happened to all be archived (you'd get a result set shorter than
    // the requested limit even if plenty of unarchived matches existed).
    const sql = `
      SELECT search_fts.content_id AS id,
             search_fts.content_type AS type,
             search_fts.title,
             search_fts.body,
             bm25(search_fts) AS rank
      FROM search_fts
      LEFT JOIN learnings l
        ON search_fts.content_type = 'learning' AND l.id = search_fts.content_id
      WHERE search_fts MATCH ?
        AND (search_fts.content_type != 'learning' OR COALESCE(l.archived, 0) = 0)
        ${typeFilter}
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

    return {
      success: true,
      data: {
        query: input.query,
        results: rows,
        count: rows.length,
      },
      message: `${rows.length} Ergebnisse für "${input.query}".`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Suchfehler: ${err instanceof Error ? err.message : String(err)}`,
      code: 'SEARCH_FAILED',
    };
  }
}
