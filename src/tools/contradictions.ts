/**
 * Contradiction scanner — P3.2 (v2.1.0).
 *
 * Surfaces observation pairs that are semantically very similar (cosine
 * similarity above a threshold) but disagree on one of two heuristic axes:
 *
 *   1. Negation marker XOR — one side asserts a fact, the other negates it.
 *      "Matthias prefers Postgres" vs "Matthias no longer prefers Postgres".
 *   2. Confidence drift — the same fact recorded twice with very different
 *      confidence values. "X is true" at 0.95 vs "X is true" at 0.45.
 *
 * The scanner is LLM-free on purpose: we want the no-API-key promise to hold.
 * The heuristic is conservative — it returns candidates the AI client can
 * judge, not verdicts. Zep's "fact supersession" is the closest comparable
 * commercial pattern; we run the same shape locally + heuristically.
 *
 * sqlite-vec is required. The cosine computation uses `vec_distance_cosine`
 * which is only registered when the extension loaded. When vec is off we
 * return a soft error with a clear message rather than silently scanning
 * with degraded accuracy.
 *
 * Scope: by default the scan is global across every entity. Pass entityId
 * (or entityName + entityType) to focus on one entity. The all-entities path
 * relies on the intra-entity self-join (`b.entity_id = a.entity_id`) so the
 * pair count stays bounded by Σ N²/2 over entities — typically a few hundred
 * pairs even for power users with thousands of observations spread across
 * dozens of entities.
 *
 * Output schema:
 *   - `pairs`: list of contradiction candidates, each with the older +
 *     newer observation, the cosine similarity, and the reasons flagged.
 *   - `count`: number of pairs returned (capped by `limit`).
 *   - `scope`: 'all' or `entity:<id>`.
 *
 * The "supersede" suggestion is descriptive only — V2.1.0 does NOT mutate
 * valid_to / valid_from. A future tool (V2.2.0 `memory_observation_supersede`)
 * will accept the older.id and set its valid_to to newer.valid_from.
 */
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { isVectorEnabled } from '../db/vector.js';
import type { ToolResult } from '../lib/types.js';

// Heuristic regex for "this content is a negation of something". Covers the
// full Romance + Germanic + English surface so the cosine-similarity layer
// (which is multilingual via Xenova/multilingual-e5-small) doesn't out-cover
// the negation layer. Languages: EN / DE / ES / Catalan / Portuguese /
// Italian / French — the seven the embedding model handles strongest and
// the ones a Mallorca-Mediterranean user mixes and switches between.
//
// R1 Research F4: the v0 regex only covered EN/DE/ES/Catalan + partial PT.
// Closing the gap silently dropped negation detection mid-conversation when
// a user switched to French or Italian. The cost of adding the markers is a
// single character class — the runtime cost is unchanged. Source survey:
// MDPI 2022 "Multilingual Negation Survey" + Cambridge 2024 "Supervised
// Learning for Negation Detection in French and Brazilian Portuguese
// Biomedical Corpora" — both confirm rule-based detection stays viable
// when the marker lexicon is exhaustive.
//
// The regex is compiled once at module load so the per-pair test is cheap.
const NEGATION_MARKER =
  /\b(no\s+longer|not|never|n[''`]t|none|kein|keine|keiner|keinen|keinem|nicht|niemals|nie|ohne|sin|sem|n[oa]o|nunca|nenhum|nenhuma|jamais|pas|ne|aucun|aucune|sans|mai|nessuno|nessuna|senza|niente)\b/iu;

export const contradictionsSchema = z.object({
  entityId: z.string().min(1).optional(),
  entityName: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  minCosine: z.number().min(0).max(1).optional(),
  minConfidenceDrift: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

type ContradictionRow = {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  id_a: string;
  id_b: string;
  cosine_sim: number;
  content_a: string;
  content_b: string;
  conf_a: number;
  conf_b: number;
  from_a: string;
  from_b: string;
};

export function contradictions(input: z.infer<typeof contradictionsSchema>): ToolResult {
  if (!isVectorEnabled()) {
    return {
      success: false,
      error:
        'Contradiction detection requires the sqlite-vec extension to be loaded. Either install on a supported platform (linux-x64, darwin-x64, darwin-arm64, win32-x64) or unset MEMORY_EMBED_DISABLED=1.',
      code: 'VECTOR_DISABLED',
    };
  }

  const db = getDb();
  // R1 Research F3: default minCosine raised from 0.7 → 0.75. The 0.7
  // boundary is where the published retrieval literature consistently
  // reports a sharp rise in false-positive rate (SparseCL on Arguana 2024;
  // Milvus threshold-tuning guidance 2026). 0.75 is the conservative-
  // default-don't-surprise-the-user setting; recall-heavy callers can lower
  // it explicitly via the `minCosine` parameter.
  const minCosine = input.minCosine ?? 0.75;
  const minConfDrift = input.minConfidenceDrift ?? 0.2;
  const limit = input.limit ?? 20;

  // Resolve scope. Order of precedence: entityId > entityName + entityType >
  // global scan. If a lookup misses we return an explicit NOT_FOUND so the
  // user doesn't silently get an all-entities scan when they meant to pin to
  // one entity.
  let entityScopeId: string | null = null;
  if (input.entityId) {
    const row = db
      .prepare('SELECT id FROM entities WHERE id = ?')
      .get(input.entityId) as { id: string } | undefined;
    if (!row) {
      return { success: false, error: 'Entity not found by id.', code: 'NOT_FOUND' };
    }
    entityScopeId = row.id;
  } else if (input.entityName) {
    const sql = input.entityType
      ? 'SELECT id FROM entities WHERE name = ? AND entity_type = ? LIMIT 1'
      : 'SELECT id FROM entities WHERE name = ? LIMIT 1';
    const args = input.entityType ? [input.entityName, input.entityType] : [input.entityName];
    const row = db.prepare(sql).get(...args) as { id: string } | undefined;
    if (!row) {
      return { success: false, error: 'Entity not found by name.', code: 'NOT_FOUND' };
    }
    entityScopeId = row.id;
  }

  // Query candidate pairs. The intra-entity self-join (b.entity_id = a.entity_id
  // and b.id < a.id) keeps the pair set O(Σ N²/2) instead of O(total²). The
  // outer SELECT applies the cosine threshold so vec0 can short-circuit on
  // hopeless pairs early. We also bound the over-fetch at 5× the final limit
  // so the negation/confidence post-filter has room to throw away false-flags
  // while still hitting the user's requested count.
  //
  // CAUTION: this calls `vec_distance_cosine` per pair. The optimiser will
  // typically pull the embeddings only once per pair (the JOIN provides them)
  // but the cosine function itself is a 384-float dot-product per call. For a
  // power user with 1000 obs evenly spread across 20 entities that's ~25k
  // calls — completes in well under a second on modern CPUs.
  //
  // Sort: by cosine_sim DESC so the most-similar (most suspicious) pairs
  // surface first. Ties broken by from_a DESC so newer pairs win.
  const overFetch = Math.min(limit * 5, 500);

  const scopeFilter = entityScopeId ? 'AND a.entity_id = ?' : '';
  const sql = `
    SELECT *
    FROM (
      SELECT a.entity_id AS entity_id,
             e.name AS entity_name,
             e.entity_type AS entity_type,
             a.id AS id_a,
             b.id AS id_b,
             (1.0 - vec_distance_cosine(ea.embedding, eb.embedding)) AS cosine_sim,
             a.content AS content_a,
             b.content AS content_b,
             a.confidence AS conf_a,
             b.confidence AS conf_b,
             a.valid_from AS from_a,
             b.valid_from AS from_b
      FROM entity_observations a
      JOIN entity_observations b
        ON b.entity_id = a.entity_id AND b.id < a.id
      JOIN embeddings ea ON ea.content_id = a.id
      JOIN embeddings eb ON eb.content_id = b.id
      JOIN entities e ON e.id = a.entity_id
      WHERE a.valid_to IS NULL
        AND b.valid_to IS NULL
        ${scopeFilter}
    ) AS pairs
    WHERE cosine_sim >= ?
    ORDER BY cosine_sim DESC, from_a DESC
    LIMIT ?
  `;

  const args: unknown[] = [];
  if (entityScopeId) args.push(entityScopeId);
  args.push(minCosine);
  args.push(overFetch);

  let candidates: ContradictionRow[];
  try {
    candidates = db.prepare(sql).all(...args) as ContradictionRow[];
  } catch (err) {
    // Most likely cause: vec_distance_cosine missing because the extension
    // was unloaded between bootstrap and the call (test isolation, swap of
    // DB file). Surface clearly instead of letting the JSON-RPC frame look
    // like a generic SQL error.
    return {
      success: false,
      error: `Vector pair scan failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 'VEC_QUERY_FAILED',
    };
  }

  // Apply the negation + confidence-drift filters in JS. We do these here
  // (not in SQL) because the negation check is a Unicode regex and SQLite's
  // regex extension is not guaranteed to be present — we want zero new
  // native dependencies for V2.1.0.
  const pairs = candidates
    .map((row) => {
      const negA = NEGATION_MARKER.test(row.content_a);
      const negB = NEGATION_MARKER.test(row.content_b);
      const negationDiff = negA !== negB;
      const confDriftAbs = Math.abs(row.conf_a - row.conf_b);
      const confDriftFlag = confDriftAbs >= minConfDrift;

      if (!negationDiff && !confDriftFlag) return null;

      const reasons: string[] = [];
      if (negationDiff) reasons.push('negation_diff');
      if (confDriftFlag) reasons.push('confidence_drift');

      // Decide which side is older by valid_from. SQLite's
      // datetime('now') string is ISO-style with seconds resolution so
      // lexicographic compare is monotonic.
      const aIsOlder = row.from_a <= row.from_b;
      const older = aIsOlder
        ? { id: row.id_a, content: row.content_a, validFrom: row.from_a, confidence: row.conf_a }
        : { id: row.id_b, content: row.content_b, validFrom: row.from_b, confidence: row.conf_b };
      const newer = aIsOlder
        ? { id: row.id_b, content: row.content_b, validFrom: row.from_b, confidence: row.conf_b }
        : { id: row.id_a, content: row.content_a, validFrom: row.from_a, confidence: row.conf_a };

      return {
        entityId: row.entity_id,
        entityName: row.entity_name,
        entityType: row.entity_type,
        cosineSim: Number(row.cosine_sim.toFixed(4)),
        confidenceDrift: Number(confDriftAbs.toFixed(4)),
        reasons,
        older,
        newer,
        suggestion:
          'older observation may be superseded by newer — review and call a future memory_observation_supersede tool, or close the older one manually',
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .slice(0, limit);

  return {
    success: true,
    data: {
      pairs,
      count: pairs.length,
      scope: entityScopeId ? `entity:${entityScopeId}` : 'all',
      thresholds: {
        minCosine,
        minConfidenceDrift: minConfDrift,
      },
    },
    message:
      pairs.length === 0
        ? 'Keine Widersprüche gefunden.'
        : `${pairs.length} Widerspruch-Kandidat(en) gefunden.`,
  };
}
