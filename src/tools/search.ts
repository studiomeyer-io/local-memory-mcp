/**
 * Unified search across learnings, decisions, entities, and observations.
 *
 * v2.0.0: hybrid retrieval. We run the query through two parallel rankers —
 * FTS5/BM25 over the existing search_fts index and vector cosine against
 * sqlite-vec's `embeddings` table — and fuse the two rankings with
 * Reciprocal Rank Fusion (RRF, k=60). This is the same recipe Alex Garcia
 * documents on alexgarcia.xyz/sqlite-vec/blog/hybrid-search.
 *
 * Three modes are exposed via the `mode` parameter:
 *
 *   - 'hybrid' (default): RRF over BM25 + cosine. Best recall, multilingual,
 *     handles vocabulary mismatch ("send" finds "publish").
 *   - 'fts':              BM25 only. Same behaviour as v1.x. Fast, no model.
 *   - 'vector':           Cosine only. For pure semantic recall.
 *
 * The hybrid path requires sqlite-vec to have loaded AND an embedding to be
 * derivable from the query. If either fails (extension missing, model
 * blocked, mock-disabled in tests) we silently fall back to FTS5 — never
 * surface the error to the client, just degrade gracefully.
 */
import { z } from 'zod';
import { getDb, escapeFtsQuery } from '../db/client.js';
import { isVectorEnabled } from '../db/vector.js';
import { embedQuery, EMBEDDING_DIM } from '../lib/embed.js';
import type { ToolResult } from '../lib/types.js';

export const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  types: z.array(z.enum(['learning', 'decision', 'entity', 'observation'])).optional(),
  mode: z.enum(['fts', 'vector', 'hybrid']).optional(),
});

interface SearchRow {
  id: string;
  type: string;
  title: string;
  body: string;
  rank: number;
}

/**
 * FTS5/BM25 search — same query that powered v1.x. Extracted so the hybrid
 * path can reuse it as one half of the RRF fusion. Returns rows sorted by
 * BM25 rank ascending (smaller = better in FTS5).
 */
function ftsSearch(
  query: string,
  types: string[] | undefined,
  limit: number
): SearchRow[] {
  const db = getDb();
  const fts = escapeFtsQuery(query);

  const typeFilter =
    types && types.length > 0
      ? `AND search_fts.content_type IN (${types.map(() => '?').join(',')})`
      : '';

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
  if (types && types.length > 0) args.push(...types);
  args.push(limit);

  return db.prepare(sql).all(...args) as SearchRow[];
}

/**
 * Pull top-K rows from the sqlite-vec embeddings table by cosine distance.
 * Only used when vector mode is requested or as the second leg of hybrid.
 * Joins back to FTS5 to recover title/body for the response payload.
 *
 * KNN constraint reality: sqlite-vec's vec0 module rejects WHERE constraints
 * on auxiliary columns inside a KNN query — only the partition-key columns
 * are accepted in the same WHERE that holds `embedding MATCH ?`. We model
 * `content_type` as an aux column so we can't filter on it inline. Instead
 * we (1) over-fetch the raw KNN result into a CTE, (2) join through
 * `search_fts` to recover content_type + title + body, (3) apply the
 * type-filter + archived-learnings filter in the outer query, and (4)
 * re-sort by distance and trim to `limit`. Over-fetching by ~4× covers the
 * typical case where the desired type makes up part of the index.
 */
function vectorSearch(
  vector: Float32Array,
  types: string[] | undefined,
  limit: number
): SearchRow[] {
  const db = getDb();

  // Over-fetch headroom for the post-filter step. 4× the target with a 200
  // cap keeps the work bounded on large DBs while leaving enough room to
  // recover from a heavy `types` filter.
  const overFetch = Math.min(Math.max(limit * 4, 50), 200);

  // C7 cleanup (Analyst R1): build the WHERE clause directly with the outer
  // alias `sfts.content_type` instead of building it for `vr.content_type`
  // and then string-replacing. The previous `.replace('vr.content_type',
  // 'sfts.content_type')` was a textual patch one rename away from silently
  // producing the wrong SQL.
  //
  // Boundary note (Critic R2 R2-3): the LEFT JOIN + `sfts.content_id IS NOT
  // NULL` is effectively an INNER JOIN. We use LEFT to document that ghost
  // embeddings (rows in `embeddings` without a matching `search_fts` row,
  // typically from a pre-v2 entity delete) cannot be surfaced here — the
  // result payload needs the content_type/title/body from FTS5. Cleaning up
  // ghosts is the entity-delete cascade's job (deleteEmbeddings in vector.ts).
  // A future read path that returns id-only could LEFT JOIN without the
  // NOT NULL filter and emit ghosts for diagnostic purposes.
  const typeFilter =
    types && types.length > 0
      ? `AND sfts.content_type IN (${types.map(() => '?').join(',')})`
      : '';

  const sql = `
    WITH vec_raw AS (
      SELECT content_id, distance
      FROM embeddings
      WHERE embedding MATCH ?
        AND k = ?
    )
    SELECT vr.content_id AS id,
           sfts.content_type AS type,
           sfts.title AS title,
           sfts.body AS body,
           vr.distance AS rank
    FROM vec_raw vr
    LEFT JOIN search_fts sfts ON sfts.content_id = vr.content_id
    LEFT JOIN learnings l
      ON sfts.content_type = 'learning' AND l.id = vr.content_id
    WHERE sfts.content_id IS NOT NULL
      AND (sfts.content_type != 'learning' OR COALESCE(l.archived, 0) = 0)
      ${typeFilter}
    ORDER BY vr.distance
    LIMIT ?
  `;

  const args: unknown[] = [vector, overFetch];
  if (types && types.length > 0) args.push(...types);
  args.push(limit);

  return db.prepare(sql).all(...args) as SearchRow[];
}

/**
 * Reciprocal Rank Fusion: each candidate gets score = Σ 1/(k + rank_i),
 * summed over every ranker that saw it. k=60 is the canonical hybrid-search
 * constant. We then return the top-N by fused score with the metadata of
 * whichever ranker found it first.
 */
function reciprocalRankFusion(
  rankings: SearchRow[][],
  k: number,
  limit: number
): SearchRow[] {
  const acc = new Map<
    string,
    { row: SearchRow; score: number }
  >();

  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const row = ranking[i];
      if (!row) continue;
      const key = `${row.type}:${row.id}`;
      const contribution = 1 / (k + i);
      const existing = acc.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        acc.set(key, { row, score: contribution });
      }
    }
  }

  const merged = Array.from(acc.values()).sort((a, b) => b.score - a.score);
  return merged.slice(0, limit).map(({ row, score }) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    rank: score, // RRF score — higher is better, unlike raw BM25/distance.
  }));
}

export async function search(input: z.infer<typeof searchSchema>): Promise<ToolResult> {
  const limit = input.limit ?? 20;
  const requestedMode = input.mode ?? 'hybrid';

  try {
    // Resolve effective mode based on what's actually available at runtime.
    // 'hybrid' or 'vector' requested but vec extension missing → downgrade
    // to FTS5. We record the downgrade reason so it can be returned to the
    // caller in a structured `notice` field (F5 fix from Critic R1) — that
    // way a user explicitly testing vector recall can distinguish "vector
    // ran and found nothing" from "vector silently fell back to FTS".
    let effectiveMode: 'fts' | 'vector' | 'hybrid' = requestedMode;
    let queryVector: Float32Array | null = null;
    let downgradeReason: string | null = null;

    if (effectiveMode !== 'fts') {
      if (!isVectorEnabled()) {
        downgradeReason = `requested mode "${requestedMode}" downgraded to "fts" because the sqlite-vec extension is not loaded`;
        effectiveMode = 'fts';
      } else {
        queryVector = await embedQuery(input.query);
        if (!queryVector || queryVector.length !== EMBEDDING_DIM) {
          downgradeReason = `requested mode "${requestedMode}" downgraded to "fts" because the embedding pipeline could not produce a query vector`;
          effectiveMode = 'fts';
          queryVector = null;
        }
      }
    }

    let rows: SearchRow[];
    if (effectiveMode === 'fts') {
      rows = ftsSearch(input.query, input.types, limit);
    } else if (effectiveMode === 'vector' && queryVector) {
      rows = vectorSearch(queryVector, input.types, limit);
    } else if (effectiveMode === 'hybrid' && queryVector) {
      // Pull a wider candidate pool from each ranker than `limit`, so RRF has
      // enough overlap to be meaningful. 50 is the value Alex Garcia uses in
      // the canonical hybrid-search recipe.
      const candidatePool = Math.max(limit * 3, 50);
      const ftsRows = ftsSearch(input.query, input.types, candidatePool);
      const vecRows = vectorSearch(queryVector, input.types, candidatePool);
      rows = reciprocalRankFusion([ftsRows, vecRows], 60, limit);
    } else {
      // Defensive: should be unreachable, but if state diverges we degrade.
      rows = ftsSearch(input.query, input.types, limit);
    }

    return {
      success: true,
      data: {
        query: input.query,
        results: rows,
        count: rows.length,
        mode: effectiveMode,
        requestedMode,
        ...(downgradeReason ? { notice: downgradeReason } : {}),
      },
      message: `${rows.length} Ergebnisse für "${input.query}" (mode: ${effectiveMode}${downgradeReason ? `, requested ${requestedMode}` : ''}).`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Suchfehler: ${err instanceof Error ? err.message : String(err)}`,
      code: 'SEARCH_FAILED',
    };
  }
}
