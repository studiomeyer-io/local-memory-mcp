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
 *
 * v2.3.0 adds two orthogonal capabilities:
 *   - project/tags scoping (cheap WHERE on the source tables) so a
 *     multi-project user can scope retrieval the same way insights/reflect do.
 *   - a conservative recency + usage + importance ranking boost applied
 *     post-fusion in hybrid mode (see rankingMultiplier). It re-orders near
 *     textual ties toward fresh/important rows but is tuned so it cannot
 *     override a clear textual relevance gap, and is a no-op (identity
 *     multiplier) when the ranking signals are equal.
 */
import { z } from 'zod';
import { getDb, escapeFtsQuery } from '../db/client.js';
import { isVectorEnabled } from '../db/vector.js';
import { embedQuery, EMBEDDING_DIM } from '../lib/embed.js';
import type { ToolResult } from '../lib/types.js';

// ─── Ranking-boost tunables ───────────────────────────
// Conservative defaults: the maximum combined boost a row can earn is
// recencyWeight + usageWeight + importanceWeight = 0.40, i.e. +40% on its RRF
// score. RRF gaps between adjacent ranks near the top are small relative to the
// score itself, so a row that is a clear textual winner on both rankers keeps
// its lead; the boost only decides near-ties. All three are independently
// tunable per-call via the `ranking` input or globally via env. Set them to 0
// to disable the boost entirely.
const DEFAULT_RANKING = {
  recencyWeight: 0.15,
  usageWeight: 0.1,
  importanceWeight: 0.15,
  // Exponential decay half-life in days for the recency term. A row touched
  // `halfLifeDays` ago contributes half of recencyWeight.
  halfLifeDays: 30,
} as const;

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

interface RankingOpts {
  recencyWeight: number;
  usageWeight: number;
  importanceWeight: number;
  halfLifeDays: number;
}

function resolveRanking(input?: Partial<RankingOpts>): RankingOpts {
  return {
    recencyWeight: input?.recencyWeight ?? envNum('MEMORY_RANK_RECENCY_WEIGHT', DEFAULT_RANKING.recencyWeight),
    usageWeight: input?.usageWeight ?? envNum('MEMORY_RANK_USAGE_WEIGHT', DEFAULT_RANKING.usageWeight),
    importanceWeight:
      input?.importanceWeight ?? envNum('MEMORY_RANK_IMPORTANCE_WEIGHT', DEFAULT_RANKING.importanceWeight),
    halfLifeDays: input?.halfLifeDays ?? envNum('MEMORY_RANK_HALFLIFE_DAYS', DEFAULT_RANKING.halfLifeDays),
  };
}

export const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  types: z.array(z.enum(['learning', 'decision', 'entity', 'observation'])).optional(),
  mode: z.enum(['fts', 'vector', 'hybrid']).optional(),
  // v2.3.0 scoping. `project` matches learnings/decisions whose project column
  // equals it (entity/observation rows have no project and are excluded when a
  // project filter is active). `tags` matches rows whose tags_json array
  // contains ANY of the given tags (learnings/decisions only).
  project: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).min(1).optional(),
  // v2.3.0 ranking-boost overrides (all optional, conservative defaults).
  ranking: z
    .object({
      recencyWeight: z.number().min(0).max(1).optional(),
      usageWeight: z.number().min(0).max(1).optional(),
      importanceWeight: z.number().min(0).max(1).optional(),
      halfLifeDays: z.number().positive().optional(),
    })
    .optional(),
});

interface SearchRow {
  id: string;
  type: string;
  title: string;
  body: string;
  rank: number;
  // v2.3.0 ranking signals, recovered from the source-table joins. Present for
  // every row but only meaningful per type: usageCount + importance exist on
  // learnings; recencyTs is the best per-type "freshness" timestamp.
  usageCount?: number;
  importance?: number | null;
  recencyTs?: string | null;
}

/**
 * Build the shared project/tags scoping predicate + its bound args (v2.3.0).
 *
 * The predicate references the source-table aliases the search queries already
 * join (`l` = learnings, `d` = decisions). project/tags only exist on those two
 * tables, so when either filter is active the predicate naturally excludes
 * entity/observation rows (neither branch can match them) — "scope to project
 * X" returns only project-X content, which is the least-surprising semantics.
 *
 * tags uses json_each (json1 is compiled into better-sqlite3) so a tag match is
 * exact array-membership, not a fragile LIKE substring.
 */
function buildScopeClause(
  project: string | undefined,
  tags: string[] | undefined
): { clause: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];

  if (project !== undefined) {
    parts.push(`(
      (search_fts.content_type = 'learning' AND l.project = ?)
      OR (search_fts.content_type = 'decision' AND d.project = ?)
    )`);
    args.push(project, project);
  }

  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => '?').join(',');
    parts.push(`(
      (search_fts.content_type = 'learning'
        AND EXISTS (SELECT 1 FROM json_each(l.tags_json) WHERE value IN (${placeholders})))
      OR (search_fts.content_type = 'decision'
        AND EXISTS (SELECT 1 FROM json_each(d.tags_json) WHERE value IN (${placeholders})))
    )`);
    args.push(...tags, ...tags);
  }

  return { clause: parts.length > 0 ? `AND ${parts.join(' AND ')}` : '', args };
}

/**
 * FTS5/BM25 search — same query that powered v1.x. Extracted so the hybrid
 * path can reuse it as one half of the RRF fusion. Returns rows sorted by
 * BM25 rank ascending (smaller = better in FTS5).
 *
 * v2.3.0: the SELECT now also pulls the ranking signals (usage_count,
 * importance, a per-type recency timestamp) and the query LEFT JOINs decisions
 * + entities so the project/tags scope predicate and the boost have the columns
 * they need.
 */
function ftsSearch(
  query: string,
  types: string[] | undefined,
  limit: number,
  project: string | undefined,
  tags: string[] | undefined
): SearchRow[] {
  const db = getDb();
  const fts = escapeFtsQuery(query);

  const typeFilter =
    types && types.length > 0
      ? `AND search_fts.content_type IN (${types.map(() => '?').join(',')})`
      : '';

  const scope = buildScopeClause(project, tags);

  // Two visibility gates, mirroring how the live entity views work:
  //   - archived learnings (archived = 1) never surface.
  //   - superseded observations (valid_to IS NOT NULL) never surface in LIVE
  //     search. They stay reachable through entity_open({asOf}) for
  //     point-in-time queries. Added v2.2.0 alongside memory_observation_
  //     supersede — without it a retired fact would vanish from the entity
  //     view but still leak into unified search.
  const sql = `
    SELECT search_fts.content_id AS id,
           search_fts.content_type AS type,
           search_fts.title,
           search_fts.body,
           bm25(search_fts) AS rank,
           COALESCE(l.usage_count, 0) AS usageCount,
           l.importance AS importance,
           CASE search_fts.content_type
             WHEN 'learning'    THEN COALESCE(l.last_used, l.date)
             WHEN 'decision'    THEN d.date
             WHEN 'observation' THEN COALESCE(eo.valid_from, eo.created_at)
             WHEN 'entity'      THEN en.updated_at
           END AS recencyTs
    FROM search_fts
    LEFT JOIN learnings l
      ON search_fts.content_type = 'learning' AND l.id = search_fts.content_id
    LEFT JOIN decisions d
      ON search_fts.content_type = 'decision' AND d.id = search_fts.content_id
    LEFT JOIN entity_observations eo
      ON search_fts.content_type = 'observation' AND eo.id = search_fts.content_id
    LEFT JOIN entities en
      ON search_fts.content_type = 'entity' AND en.id = search_fts.content_id
    WHERE search_fts MATCH ?
      AND (search_fts.content_type != 'learning' OR COALESCE(l.archived, 0) = 0)
      AND (search_fts.content_type != 'observation' OR eo.valid_to IS NULL)
      ${typeFilter}
      ${scope.clause}
    ORDER BY rank
    LIMIT ?
  `;

  const args: unknown[] = [fts];
  if (types && types.length > 0) args.push(...types);
  args.push(...scope.args);
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
 *
 * v2.3.0: same source-table joins as ftsSearch so the scope predicate + the
 * ranking-boost columns are available on the vector leg too.
 */
function vectorSearch(
  vector: Float32Array,
  types: string[] | undefined,
  limit: number,
  project: string | undefined,
  tags: string[] | undefined
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

  // The scope predicate is written against `search_fts.*` aliases; the vector
  // query exposes the FTS row as `sfts`, so rewrite the alias for this leg.
  const scopeRaw = buildScopeClause(project, tags);
  const scopeClause = scopeRaw.clause.replace(/search_fts\./g, 'sfts.');

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
           vr.distance AS rank,
           COALESCE(l.usage_count, 0) AS usageCount,
           l.importance AS importance,
           CASE sfts.content_type
             WHEN 'learning'    THEN COALESCE(l.last_used, l.date)
             WHEN 'decision'    THEN d.date
             WHEN 'observation' THEN COALESCE(eo.valid_from, eo.created_at)
             WHEN 'entity'      THEN en.updated_at
           END AS recencyTs
    FROM vec_raw vr
    LEFT JOIN search_fts sfts ON sfts.content_id = vr.content_id
    LEFT JOIN learnings l
      ON sfts.content_type = 'learning' AND l.id = vr.content_id
    LEFT JOIN decisions d
      ON sfts.content_type = 'decision' AND d.id = vr.content_id
    LEFT JOIN entity_observations eo
      ON sfts.content_type = 'observation' AND eo.id = vr.content_id
    LEFT JOIN entities en
      ON sfts.content_type = 'entity' AND en.id = vr.content_id
    WHERE sfts.content_id IS NOT NULL
      AND (sfts.content_type != 'learning' OR COALESCE(l.archived, 0) = 0)
      AND (sfts.content_type != 'observation' OR eo.valid_to IS NULL)
      ${typeFilter}
      ${scopeClause}
    ORDER BY vr.distance
    LIMIT ?
  `;

  const args: unknown[] = [vector, overFetch];
  if (types && types.length > 0) args.push(...types);
  args.push(...scopeRaw.args);
  args.push(limit);

  return db.prepare(sql).all(...args) as SearchRow[];
}

/**
 * Compute the conservative ranking multiplier for a single fused row (v2.3.0).
 *
 * multiplier = 1
 *   + recencyWeight    * exp(-ageDays / halfLifeDays)     // fresh > stale
 *   + usageWeight      * usage_count / (usage_count + 5)  // used > unused (saturating)
 *   + importanceWeight * clamp(importance, 0, 1)          // important > not
 *
 * Every term is >= 0, so the multiplier is always >= 1 — the boost can only
 * lift a row, never sink it below its base RRF score. Missing signals
 * contribute 0 (no recencyTs => no recency term, null importance => no
 * importance term), so two rows with identical signals get the identical
 * multiplier and their relative order is governed purely by the base RRF score
 * (the equal-signals invariance the tests assert).
 */
function rankingMultiplier(row: SearchRow, opts: RankingOpts, nowMs: number): number {
  let recency = 0;
  if (row.recencyTs) {
    // SQLite stores 'YYYY-MM-DD HH:MM:SS' (space, UTC, no zone). Normalise to an
    // ISO instant so Date.parse is unambiguous across engines.
    const iso = row.recencyTs.includes('T') ? row.recencyTs : row.recencyTs.replace(' ', 'T') + 'Z';
    const ts = Date.parse(iso);
    if (Number.isFinite(ts)) {
      const ageDays = Math.max(0, (nowMs - ts) / 86_400_000);
      recency = Math.exp(-ageDays / opts.halfLifeDays);
    }
  }

  const usage = row.usageCount && row.usageCount > 0 ? row.usageCount / (row.usageCount + 5) : 0;

  const importance =
    row.importance != null && Number.isFinite(row.importance)
      ? Math.min(1, Math.max(0, row.importance))
      : 0;

  return 1 + opts.recencyWeight * recency + opts.usageWeight * usage + opts.importanceWeight * importance;
}

/**
 * Reciprocal Rank Fusion: each candidate gets score = Σ 1/(k + rank_i),
 * summed over every ranker that saw it. k=60 is the canonical hybrid-search
 * constant. We then return the top-N by fused score with the metadata of
 * whichever ranker found it first.
 *
 * v2.3.0: after fusion we multiply each candidate's RRF score by a recency /
 * usage / importance multiplier (rankingMultiplier) and re-sort. The boost is
 * a no-op when `ranking` weights are all 0 or when every candidate shares the
 * same signals — the relative order then collapses back to the pure RRF order.
 */
function reciprocalRankFusion(
  rankings: SearchRow[][],
  k: number,
  limit: number,
  ranking: RankingOpts
): SearchRow[] {
  const acc = new Map<
    string,
    { row: SearchRow; score: number }
  >();

  for (const r of rankings) {
    for (let i = 0; i < r.length; i++) {
      const row = r[i];
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

  const nowMs = Date.now();
  const merged = Array.from(acc.values())
    .map(({ row, score }) => ({ row, score: score * rankingMultiplier(row, ranking, nowMs) }))
    .sort((a, b) => b.score - a.score);

  return merged.slice(0, limit).map(({ row, score }) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    rank: score, // RRF score (boosted) — higher is better, unlike raw BM25/distance.
  }));
}

export async function search(input: z.infer<typeof searchSchema>): Promise<ToolResult> {
  const limit = input.limit ?? 20;
  const requestedMode = input.mode ?? 'hybrid';
  const ranking = resolveRanking(input.ranking);
  const { project, tags } = input;

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
      rows = ftsSearch(input.query, input.types, limit, project, tags);
    } else if (effectiveMode === 'vector' && queryVector) {
      rows = vectorSearch(queryVector, input.types, limit, project, tags);
    } else if (effectiveMode === 'hybrid' && queryVector) {
      // Pull a wider candidate pool from each ranker than `limit`, so RRF has
      // enough overlap to be meaningful. 50 is the value Alex Garcia uses in
      // the canonical hybrid-search recipe.
      const candidatePool = Math.max(limit * 3, 50);
      const ftsRows = ftsSearch(input.query, input.types, candidatePool, project, tags);
      const vecRows = vectorSearch(queryVector, input.types, candidatePool, project, tags);
      rows = reciprocalRankFusion([ftsRows, vecRows], 60, limit, ranking);
    } else {
      // Defensive: should be unreachable, but if state diverges we degrade.
      rows = ftsSearch(input.query, input.types, limit, project, tags);
    }

    // Trim the internal ranking-signal columns from the public payload — they
    // are an implementation detail of the boost, not part of the result shape.
    const results = rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, rank: r.rank }));

    return {
      success: true,
      data: {
        query: input.query,
        results,
        count: results.length,
        mode: effectiveMode,
        requestedMode,
        ...(project ? { project } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(downgradeReason ? { notice: downgradeReason } : {}),
      },
      message: `${results.length} results for "${input.query}" (mode: ${effectiveMode}${downgradeReason ? `, requested ${requestedMode}` : ''}).`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Suchfehler: ${err instanceof Error ? err.message : String(err)}`,
      code: 'SEARCH_FAILED',
    };
  }
}
