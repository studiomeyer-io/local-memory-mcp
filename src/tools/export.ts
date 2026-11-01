/**
 * Portability tools — memory_export + memory_import (v2.2.0).
 *
 * "You own your data" made concrete, and the on-ramp to the hosted tier.
 * The export envelope is a versioned, camelCase JSON document that maps 1:1
 * onto the StudioMeyer Memory SaaS import format (memory.studiomeyer.io), so
 * the same file restores a local DB *or* seeds a hosted account — the local
 * server is the funnel, not a dead end.
 *
 * Design:
 *   - Envelope carries the source rows only. Embeddings are NOT exported —
 *     they're a derived artifact and are re-computed on import from the
 *     content with whatever model the importing machine runs (the export stays
 *     small + model-agnostic; a 384-dim local model and a hosted model can
 *     both ingest the same file).
 *   - search_fts is also omitted — it's rebuilt automatically by the insert
 *     triggers as rows land.
 *   - Import is PURELY ADDITIVE and idempotent: every write is INSERT OR
 *     IGNORE keyed on the source id (entities additionally dedupe on their
 *     UNIQUE(name, entity_type)). Re-importing the same file twice is a no-op;
 *     importing into a populated DB never clobbers an existing row. There is
 *     deliberately no 'replace' mode — wiping a local store is `rm memory.sqlite`,
 *     not a tool that can silently delete a user's history.
 *   - Referential integrity is preserved by FK-safe ordering (sessions →
 *     entities → observations → relations) plus dangling-reference skips: an
 *     observation whose entity is absent, or a relation whose endpoint is
 *     absent, is skipped and counted rather than throwing.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getDb, nowIso } from '../db/client.js';
import { prepareEmbeddingBatch, writeEmbeddingSync } from '../db/vector.js';
import { decisionEmbeddingText } from './decide.js';
import { LEARNING_CATEGORIES } from './learn.js';
import { logger } from '../lib/logger.js';
import type { ToolResult, LearningCategory } from '../lib/types.js';

const EXPORT_FORMAT = 'studiomeyer-memory-export';
const EXPORT_VERSION = 1;

// ─── export ──────────────────────────────────────────

export const memoryExportSchema = z.object({
  includeSessions: z.boolean().optional(), // default true
  includeArchived: z.boolean().optional(), // default true (full-fidelity backup)
});

export function memoryExport(input: z.infer<typeof memoryExportSchema>): ToolResult {
  const db = getDb();
  const includeSessions = input.includeSessions ?? true;
  const includeArchived = input.includeArchived ?? true;

  const archivedFilter = includeArchived ? '' : 'WHERE archived = 0';

  const learnings = (
    db
      .prepare(
        `SELECT id, date, category, content, project, tags_json, usage_count,
                last_used, confidence, source, verified, verified_at,
                archived, archived_at, importance, lifecycle_state, memory_type
         FROM learnings ${archivedFilter} ORDER BY date`
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id,
    date: r.date,
    category: r.category,
    content: r.content,
    project: r.project,
    tags: safeJsonArray(r.tags_json),
    usageCount: r.usage_count,
    lastUsed: r.last_used,
    confidence: r.confidence,
    source: r.source,
    verified: r.verified,
    verifiedAt: r.verified_at,
    archived: r.archived,
    archivedAt: r.archived_at,
    importance: r.importance,
    lifecycleState: r.lifecycle_state,
    memoryType: r.memory_type,
  }));

  const decisions = (
    db
      .prepare(
        `SELECT id, date, title, decision, alternatives, reasoning, project,
                tags_json, confidence, source, verified, verified_at
         FROM decisions ORDER BY date`
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id,
    date: r.date,
    title: r.title,
    decision: r.decision,
    alternatives: r.alternatives,
    reasoning: r.reasoning,
    project: r.project,
    tags: safeJsonArray(r.tags_json),
    confidence: r.confidence,
    source: r.source,
    verified: r.verified,
    verifiedAt: r.verified_at,
  }));

  const entities = (
    db
      .prepare(
        `SELECT id, name, entity_type, created_at, updated_at, summary, confidence
         FROM entities ORDER BY created_at`
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    summary: r.summary,
    confidence: r.confidence,
  }));

  const observations = (
    db
      .prepare(
        `SELECT id, entity_id, content, source, session_id, valid_from, valid_to,
                confidence, created_at
         FROM entity_observations ORDER BY created_at`
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    content: r.content,
    source: r.source,
    sessionId: r.session_id,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    confidence: r.confidence,
    createdAt: r.created_at,
  }));

  const relations = (
    db
      .prepare(
        `SELECT id, from_entity_id, to_entity_id, relation_type, weight, created_at
         FROM entity_relations ORDER BY created_at`
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id,
    fromEntityId: r.from_entity_id,
    toEntityId: r.to_entity_id,
    relationType: r.relation_type,
    weight: r.weight,
    createdAt: r.created_at,
  }));

  const sessions = includeSessions
    ? (
        db
          .prepare(
            `SELECT id, started_at, ended_at, project, summary, tasks_json
             FROM sessions ORDER BY started_at`
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        project: r.project,
        summary: r.summary,
        tasks: safeJsonArray(r.tasks_json),
      }))
    : [];

  // Profile + goal live as key/value rows in meta — export them as a clean
  // object so the SaaS side doesn't have to know our meta key prefixes.
  const profileRows = db
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'profile_%'")
    .all() as Array<{ key: string; value: string }>;
  const profile: Record<string, string> = {};
  for (const r of profileRows) profile[r.key.replace(/^profile_/, '')] = r.value;
  const goalRow = db.prepare("SELECT value FROM meta WHERE key = 'current_goal'").get() as
    | { value: string }
    | undefined;
  const schemaVersion =
    (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)
      ?.value ?? 'unknown';

  const envelope = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: nowIso(),
    source: 'local-memory-mcp',
    schemaVersion,
    counts: {
      learnings: learnings.length,
      decisions: decisions.length,
      entities: entities.length,
      observations: observations.length,
      relations: relations.length,
      sessions: sessions.length,
    },
    profile,
    goal: goalRow?.value ?? null,
    learnings,
    decisions,
    entities,
    observations,
    relations,
    sessions,
  };

  const total =
    learnings.length + decisions.length + entities.length + observations.length + relations.length;

  return {
    success: true,
    data: envelope,
    message: `Export: ${total} records (${learnings.length} learnings, ${decisions.length} decisions, ${entities.length} entities, ${observations.length} observations, ${relations.length} relations${includeSessions ? `, ${sessions.length} sessions` : ''}). Embeddings are recomputed on import. This envelope also imports into memory.studiomeyer.io.`,
  };
}

// ─── import ──────────────────────────────────────────

// The ENVELOPE is validated structurally inside the handler rather than via a
// giant brittle Zod schema — this keeps us forgiving of envelopes produced by
// the SaaS side or a future exporter version, while still rejecting garbage.
// The RECORDS inside it are a different matter: until v2.4.3 they were guarded
// by isStr()/asNum() only, which made import the one write path that bypassed
// the constraints every interactive tool enforces (#29, reported by @pmario).
// An envelope could therefore land rows no tool could create — open-string
// category, confidence 999, 50k of content, and a non-UUID id.
export const memoryImportSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  mode: z.enum(['merge']).optional(), // reserved; only additive merge is supported
});

// ─── per-record validation (#29) ─────────────────────
//
// Ids must be UUIDs by the time they touch the database, and that is a
// correctness requirement rather than tidiness. An id is not confined to its
// row: it becomes the primary key in the `embeddings` table, a key in the FTS
// index, and the key of the in-memory vecMap below — which is only
// collision-free ACROSS TYPES because ids are UUIDs (see the Phase-1 comment).
// It also reaches downstream filenames in tooling built on top of an export,
// so `../x` is a traversal vector and not a cosmetic defect.
//
// We CANONICALISE rather than reject. Rejecting looks safer and is worse:
// until v2.4.2 the import accepted any string as an id, so anyone who fed this
// server through a hand-rolled importer has non-UUID rows sitting in their
// database right now. Their next memory_export carries those ids, and a strict
// import would silently drop exactly the rows a restore exists to save. Losing
// a user's data to protect them from their own backup is not a trade we make.
//
// So a non-UUID id is mapped to an RFC 4122 §4.3 name-based (v5) UUID derived
// from it. Two properties make that safe rather than merely convenient:
// deterministic, so re-importing the same envelope is still idempotent and
// INSERT OR IGNORE still dedupes; and pure, so a foreign key ('entityId',
// 'fromEntityId', …) maps to the same value as the id it points at without any
// bookkeeping. Ids that are already UUIDs pass through untouched (lower-cased),
// so a normal export round-trips byte-for-byte.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A fixed namespace, so the mapping is stable across machines and versions.
// Changing this constant would re-key every legacy id — treat it as frozen.
const ID_NAMESPACE_HEX = '9f3a1c52e4b74d6b8a1e05c3d7f24b90';

function canonicaliseId(raw: string): string {
  if (UUID_RE.test(raw)) return raw.toLowerCase();
  const h = createHash('sha1');
  h.update(Buffer.from(ID_NAMESPACE_HEX, 'hex'));
  // utf16le, NOT utf8. UTF-8 encoding replaces every unpaired surrogate
  // (U+D800..U+DFFF) with U+FFFD, so the distinct ids "\uD800" and "\uD801" —
  // both perfectly transportable in JSON — would hash identically and the
  // second record would be discarded as a duplicate of the first. utf16le is
  // lossless over the whole 16-bit range. Same reason secret comparison in this
  // house uses utf16le.
  h.update(Buffer.from(raw, 'utf16le'));
  const b = h.digest();
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = b.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// The bound matters independently of the shape: it caps the work done before
// canonicalisation, and no legitimate id is anywhere near it.
const zId = z.string().min(1).max(200).transform(canonicaliseId);

// Optional-with-default fields stay permissive about ABSENCE (an older or
// leaner exporter may omit them) but strict about CONTENT: if a value is
// present it has to satisfy the same bound the interactive tool applies.
// `.nullable()` because JSON round-trips SQL NULLs as null, not undefined.
const zOptStr = (max: number) => z.string().max(max).nullish();
const zConfidence = z.number().min(0).max(1).nullish();
const zCount = z.number().int().min(0).nullish();
const zFlag = z.union([z.literal(0), z.literal(1), z.boolean()]).nullish();
const zIsoish = z.string().max(64).nullish();
const zTags = z.array(z.string().max(200)).max(100).nullish();

// Bounds mirror learnSchema / decideSchema / entityCreateSchema /
// entityObserveSchema / entityRelateSchema. Kept as separate shapes because the
// import record is the persisted row (it carries id, timestamps and lifecycle
// columns the create-time schemas have no reason to know about).
const importSessionSchema = z.object({
  id: zId,
  startedAt: zIsoish,
  endedAt: zIsoish,
  project: zOptStr(200),
  summary: zOptStr(10000),
  // sessionEndSchema declares `tasks: z.array(z.string())`, so unknown[] was
  // looser than the tool that writes the column — and left each element
  // unbounded, so one multi-megabyte task still produced an unbounded
  // tasks_json write. Mirror the tool, and bound the element.
  tasks: z.array(z.string().max(2000)).max(1000).nullish(),
});

const importEntitySchema = z.object({
  id: zId,
  name: z.string().min(1).max(200),
  entityType: z.string().min(1).max(50),
  createdAt: zIsoish,
  updatedAt: zIsoish,
  summary: zOptStr(2000),
  confidence: zConfidence,
});

const importObservationSchema = z.object({
  id: zId,
  entityId: zId,
  content: z.string().min(1).max(5000),
  source: zOptStr(200),
  sessionId: zId.nullish(),
  validFrom: zIsoish,
  validTo: zIsoish,
  confidence: zConfidence,
  createdAt: zIsoish,
});

const importRelationSchema = z.object({
  id: zId,
  fromEntityId: zId,
  toEntityId: zId,
  relationType: z.string().min(1).max(50),
  weight: z.number().min(0).max(1).nullish(),
  createdAt: zIsoish,
});

const importLearningSchema = z.object({
  id: zId,
  date: zIsoish,
  category: z.enum(LEARNING_CATEGORIES as [LearningCategory, ...LearningCategory[]]),
  content: z.string().min(1).max(10000),
  project: zOptStr(200),
  tags: zTags,
  usageCount: zCount,
  lastUsed: zIsoish,
  confidence: zConfidence,
  source: zOptStr(200),
  verified: zFlag,
  verifiedAt: zIsoish,
  archived: zFlag,
  archivedAt: zIsoish,
  importance: z.number().min(0).max(1).nullish(),
  lifecycleState: z.enum(['active', 'ephemeral', 'archived']).nullish(),
  memoryType: z.enum(['episodic', 'semantic']).nullish(),
});

const importDecisionSchema = z.object({
  id: zId,
  date: zIsoish,
  title: z.string().min(1).max(200),
  decision: z.string().min(1).max(10000),
  // reasoning is NOT NULL in the schema — a decision without it would insert ''
  // and degrade the FTS body, so it is required here rather than defaulted (C1).
  reasoning: z.string().min(1).max(10000),
  alternatives: zOptStr(10000),
  project: zOptStr(200),
  tags: zTags,
  confidence: zConfidence,
  source: zOptStr(200),
  verified: zFlag,
  verifiedAt: zIsoish,
});

/**
 * Validate one record, returning the parsed value or null.
 *
 * Unknown keys are stripped rather than rejected: a NEWER exporter adding a
 * column must not make its envelopes unimportable by an older server. Bad
 * VALUES are rejected; extra FIELDS are not. Failures are counted by the
 * caller in `skipped.malformed`, so a single bad record never aborts the
 * envelope and the import stays additive.
 */
function parseRecord<T extends z.ZodTypeAny>(
  schema: T,
  rec: Record<string, unknown>,
  kind: string
): z.infer<T> | null {
  const res = schema.safeParse(rec);
  if (res.success) return res.data;
  const why = res.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  logger.warn(`[import] skipped malformed ${kind}: ${why}`);
  return null;
}

/** SQLite has no boolean type — normalise 0/1/true/false to an integer flag. */
function flagToInt(v: unknown, fallback: 0 | 1 = 0): 0 | 1 {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  return fallback;
}

/**
 * Reject a record whose id has already been claimed in this envelope.
 *
 * Valid UUID SYNTAX is not UNIQUENESS. The Phase-1 comment leans on ids being
 * collision-free across record types to justify a single id-keyed vecMap, and
 * a hand-built envelope can repeat one — within a type or across two. The
 * INSERT OR IGNORE would quietly drop the second row while the vecMap had
 * already handed its embedding to the first, attaching one record's vector to
 * another record's text. Cheap to close, so we close it: first occurrence
 * wins, every later one is malformed.
 *
 * The set spans ALL types on purpose, because the vecMap does too.
 */
function claimId(seen: Set<string>, id: string, kind: string): boolean {
  if (seen.has(id)) {
    logger.warn(`[import] skipped ${kind}: id ${id} appears more than once in this envelope`);
    return false;
  }
  seen.add(id);
  return true;
}

// Envelope-level caps. The record shapes bound each row, but nothing bounded
// the envelope itself: `profile` values and `goal` went into the meta table
// with no length check at all, and the arrays had no element ceiling. None of
// this is reachable by an exporter of ours — it is the hand-built-envelope
// case, which is the whole reason #29 existed.
const MAX_ARRAY_ITEMS = 100_000;
const MAX_META_VALUE = 10_000;
const MAX_META_KEY = 100;

interface ImportArrays {
  learnings: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
}

export async function memoryImport(input: z.infer<typeof memoryImportSchema>): Promise<ToolResult> {
  const db = getDb();
  const env = input.data as Record<string, unknown>;

  // Structural validation — format tag + a supported version.
  if (env.format !== EXPORT_FORMAT) {
    return {
      success: false,
      error: `Unrecognised export format. Expected "${EXPORT_FORMAT}", got "${String(env.format)}".`,
      code: 'BAD_FORMAT',
    };
  }
  // Reject NaN / 0 / negative / non-integer as well as too-new. (typeof NaN is
  // 'number' and NaN > 1 is false, so the naive check let NaN through — C2.)
  if (!Number.isInteger(env.version) || (env.version as number) < 1 || (env.version as number) > EXPORT_VERSION) {
    return {
      success: false,
      error: `Unsupported export version ${String(env.version)}. This server understands v1..v${EXPORT_VERSION}. Upgrade local-memory-mcp.`,
      code: 'UNSUPPORTED_VERSION',
    };
  }

  // Slicing rather than refusing keeps the import additive: an oversized
  // envelope still lands what it can instead of failing whole. The overflow is
  // reported through skipped.malformed like any other unusable record.
  let overLimit = 0;
  const arr = (k: string): Array<Record<string, unknown>> => {
    if (!Array.isArray(env[k])) return [];
    const a = env[k] as Array<Record<string, unknown>>;
    if (a.length > MAX_ARRAY_ITEMS) {
      overLimit += a.length - MAX_ARRAY_ITEMS;
      logger.warn(`[import] ${k}: ${a.length} items exceeds the ${MAX_ARRAY_ITEMS} cap — truncating`);
      return a.slice(0, MAX_ARRAY_ITEMS);
    }
    return a;
  };
  const data: ImportArrays = {
    learnings: arr('learnings'),
    decisions: arr('decisions'),
    entities: arr('entities'),
    observations: arr('observations'),
    relations: arr('relations'),
    sessions: arr('sessions'),
  };

  // Phase 0 (sync, cheap): parse every record ONCE, up front.
  //
  // All six types are parsed here rather than inline at insert time so that the
  // id-uniqueness check below can span the whole envelope, and so the embed
  // phase and the insert phase work from literally the same objects instead of
  // two hand-kept copies of the same rules (that copy is what drifted before
  // #29). Order matches the FK-safe insert order, so when two records claim one
  // id the one that would have been inserted first is the one that wins.
  // TWO claim spaces, drawn along where ids actually have to be unique.
  //
  // `embeddings.content_id` is one namespace shared by entities, observations,
  // learnings and decisions — writeEmbeddingSync deletes by content_id alone,
  // and backfillEntityEmbeddings keys entities there too. Those four therefore
  // cannot hold the same id even though they live in different tables: one
  // would overwrite the other's vector, and the in-memory vecMap has the same
  // shape. They share a claim space.
  //
  // Sessions and relations carry no embedding, so their ids only have to be
  // unique within their own table. Giving them their own space avoids
  // discarding a legitimate legacy envelope that happens to number its
  // sessions and its entities from the same sequence — exactly the hand-rolled
  // shape this release is trying to keep importable.
  const embeddableIds = new Set<string>();
  const sessionIds = new Set<string>();
  const relationIds = new Set<string>();
  const dedupe = <T extends { id: string }>(seen: Set<string>, r: T | null, kind: string): T | null =>
    r && claimId(seen, r.id, kind) ? r : null;

  const validSessions = data.sessions.map((s) => dedupe(sessionIds, parseRecord(importSessionSchema, s, 'session'), 'session'));
  const validEntities = data.entities.map((e) => dedupe(embeddableIds, parseRecord(importEntitySchema, e, 'entity'), 'entity'));
  const validObservations = data.observations.map((o) => dedupe(embeddableIds, parseRecord(importObservationSchema, o, 'observation'), 'observation'));
  const validRelations = data.relations.map((r) => dedupe(relationIds, parseRecord(importRelationSchema, r, 'relation'), 'relation'));
  const validLearnings = data.learnings.map((l) => dedupe(embeddableIds, parseRecord(importLearningSchema, l, 'learning'), 'learning'));
  const validDecisions = data.decisions.map((d) => dedupe(embeddableIds, parseRecord(importDecisionSchema, d, 'decision'), 'decision'));

  // Phase 1 (async, no lock): re-embed all content-bearing rows in parallel.
  // We key vectors by source id so the sync phase can attach them after a
  // successful insert. Rows whose embedding fails (vec disabled / transient)
  // simply land without a vector — FTS5 still indexes them via the triggers.
  // A single id-keyed map is safe across types because every id is a UUID by
  // this point AND has been claimed exactly once above; this also matches the
  // embeddings table, where content_id is the PK across types.
  //
  // HONEST LIMIT: schema validity is now shared between the phases and cannot
  // drift. Referential eligibility is NOT — an observation whose entity is
  // missing, or a row that INSERT OR IGNORE drops as a duplicate, is embedded
  // before we can know that. Both need the transaction to decide, and paying
  // for a wasted embedding is cheaper than holding the write lock across an
  // inference pass. The vectors are simply never attached.
  const embedJobs: Array<{ id: string; text: string }> = [];
  for (const l of validLearnings) if (l) embedJobs.push({ id: l.id, text: l.content });
  // Decisions reuse the SAME embedding text as decide() (title+decision+
  // reasoning+alternatives) so a round-tripped decision keeps its native vector.
  for (const d of validDecisions) if (d) embedJobs.push({ id: d.id, text: decisionEmbeddingText(d) });
  for (const o of validObservations) if (o) embedJobs.push({ id: o.id, text: o.content });
  // One batched forward pass for the whole import (embedBatch), not N calls.
  const vecResults = await prepareEmbeddingBatch(embedJobs.map((j) => j.text));
  const vecMap = new Map<string, Float32Array | null>();
  embedJobs.forEach((j, i) => vecMap.set(j.id, vecResults[i] ?? null));

  // Best-effort embedding writes during import: unlike a single learn()/decide()
  // (where embedding + row are one atomic unit), a bulk import should NOT lose
  // every already-inserted session/entity/learning because one vec0 write
  // hiccuped on row N. Embeddings are derived + re-buildable; the source rows
  // are the truth. So we wrap the write and swallow+log, leaving the row in
  // place without a vector (FTS5 still indexed it via the insert trigger). H1.
  const safeEmbed = (id: string, type: 'learning' | 'decision' | 'observation'): void => {
    try {
      writeEmbeddingSync(db, id, type, vecMap.get(id) ?? null);
    } catch (err) {
      logger.warn(`[import] embedding write skipped for ${type}:${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const counts = {
    learnings: 0,
    decisions: 0,
    entities: 0,
    observations: 0,
    relations: 0,
    sessions: 0,
    profileFields: 0,
  };
  const skipped = {
    observationsMissingEntity: 0,
    relationsMissingEndpoint: 0,
    // Records dropped by the per-array cap never reached a schema, so they are
    // counted here rather than being invisible. Silent truncation would read as
    // "imported everything" when it did not.
    malformed: overLimit,
  };

  // Phase 2 (sync, single transaction): FK-safe insert order. Either the whole
  // import commits or it rolls back — no half-imported graph.
  const entityExists = db.prepare('SELECT 1 FROM entities WHERE id = ? LIMIT 1');
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1');

  const tx = db.transaction(() => {
    // Profile + goal — additive only (never clobber an existing local profile).
    // Bounded since #29-followup: these were the last two writes reaching the
    // DB with no length check, and `profile` also took its KEY straight from
    // the envelope. Non-array/plain-object check first — `typeof [] === 'object'`.
    if (env.profile && typeof env.profile === 'object' && !Array.isArray(env.profile)) {
      const ins = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
      for (const [k, v] of Object.entries(env.profile as Record<string, unknown>)) {
        if (typeof v !== 'string' || v.length > MAX_META_VALUE) continue;
        // Keys become `profile_<k>` meta rows. Bound the length and refuse
        // control characters, but nothing stricter: profileSchema takes any
        // string as `field`, so a user's own `profile({field: 'display name'})`
        // is legitimate and a charset whitelist would drop it on re-import —
        // the same silent-data-loss mistake the id rule was corrected for.
        if (!k || k.length > MAX_META_KEY) continue;
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(k)) continue;
        const info = ins.run(`profile_${k}`, v);
        if (info.changes > 0) counts.profileFields++;
      }
    }
    if (isStr(env.goal) && env.goal.length <= MAX_META_VALUE) {
      db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('current_goal', env.goal);
    }

    // 1) Sessions
    const sIns = db.prepare(
      `INSERT OR IGNORE INTO sessions (id, started_at, ended_at, project, summary, tasks_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of validSessions) {
      if (!s) { skipped.malformed++; continue; }
      const info = sIns.run(
        s.id,
        s.startedAt || nowIso(),
        s.endedAt || null,
        s.project || null,
        s.summary || null,
        JSON.stringify(s.tasks ?? [])
      );
      if (info.changes > 0) counts.sessions++;
    }

    // 2) Entities (dedupe on PK and on UNIQUE(name, entity_type))
    const eIns = db.prepare(
      `INSERT OR IGNORE INTO entities (id, name, entity_type, created_at, updated_at, summary, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of validEntities) {
      if (!e) { skipped.malformed++; continue; }
      const info = eIns.run(
        e.id,
        e.name,
        e.entityType,
        e.createdAt || nowIso(),
        e.updatedAt || nowIso(),
        e.summary || null,
        e.confidence ?? 0.7
      );
      if (info.changes > 0) counts.entities++;
    }

    // 3) Observations — entity must exist (imported now OR pre-existing).
    //    session_id is nulled if the referenced session isn't present.
    const oIns = db.prepare(
      `INSERT OR IGNORE INTO entity_observations
       (id, entity_id, content, source, session_id, valid_from, valid_to, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const o of validObservations) {
      if (!o) { skipped.malformed++; continue; }
      if (!entityExists.get(o.entityId)) { skipped.observationsMissingEntity++; continue; }
      const sessId = o.sessionId && sessionExists.get(o.sessionId) ? o.sessionId : null;
      const info = oIns.run(
        o.id,
        o.entityId,
        o.content,
        o.source || null,
        sessId,
        o.validFrom || nowIso(),
        o.validTo || null,
        o.confidence ?? 0.7,
        o.createdAt || nowIso()
      );
      if (info.changes > 0) {
        counts.observations++;
        safeEmbed(o.id, 'observation');
      }
    }

    // 4) Relations — both endpoints must exist.
    const rIns = db.prepare(
      `INSERT OR IGNORE INTO entity_relations (id, from_entity_id, to_entity_id, relation_type, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const rel of validRelations) {
      if (!rel) { skipped.malformed++; continue; }
      if (!entityExists.get(rel.fromEntityId) || !entityExists.get(rel.toEntityId)) {
        skipped.relationsMissingEndpoint++;
        continue;
      }
      const info = rIns.run(
        rel.id,
        rel.fromEntityId,
        rel.toEntityId,
        rel.relationType,
        rel.weight ?? 1.0,
        rel.createdAt || nowIso()
      );
      if (info.changes > 0) counts.relations++;
    }

    // 5) Learnings
    const lIns = db.prepare(
      `INSERT OR IGNORE INTO learnings
       (id, date, category, content, project, tags_json, usage_count, last_used,
        confidence, source, verified, verified_at, archived, archived_at,
        importance, lifecycle_state, memory_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of validLearnings) {
      if (!l) { skipped.malformed++; continue; }
      const info = lIns.run(
        l.id,
        l.date || nowIso(),
        l.category,
        l.content,
        l.project || null,
        JSON.stringify(l.tags ?? []),
        l.usageCount ?? 0,
        l.lastUsed || null,
        l.confidence ?? 0.7,
        l.source || null,
        flagToInt(l.verified),
        l.verifiedAt || null,
        flagToInt(l.archived),
        l.archivedAt || null,
        l.importance ?? null,
        l.lifecycleState || 'active',
        l.memoryType || 'semantic'
      );
      if (info.changes > 0) {
        counts.learnings++;
        safeEmbed(l.id, 'learning');
      }
    }

    // 6) Decisions
    const dIns = db.prepare(
      `INSERT OR IGNORE INTO decisions
       (id, date, title, decision, alternatives, reasoning, project, tags_json,
        confidence, source, verified, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of validDecisions) {
      // reasoning is NOT NULL in the schema — a decision without it is malformed
      // (would insert '' and degrade the FTS body). Skip rather than corrupt. C1.
      if (!d) { skipped.malformed++; continue; }
      const info = dIns.run(
        d.id,
        d.date || nowIso(),
        d.title,
        d.decision,
        d.alternatives || null,
        d.reasoning,
        d.project || null,
        JSON.stringify(d.tags ?? []),
        d.confidence ?? 0.7,
        d.source || null,
        flagToInt(d.verified),
        d.verifiedAt || null
      );
      if (info.changes > 0) {
        counts.decisions++;
        safeEmbed(d.id, 'decision');
      }
    }
  });
  tx();

  const totalImported =
    counts.learnings + counts.decisions + counts.entities + counts.observations + counts.relations;
  const totalSkipped =
    skipped.observationsMissingEntity + skipped.relationsMissingEndpoint + skipped.malformed;

  return {
    success: true,
    data: { imported: counts, skipped, mode: 'merge' },
    message: `Import: ${totalImported} new records added (additive, duplicates skipped).${totalSkipped > 0 ? ` ${totalSkipped} skipped (missing references or malformed).` : ''}`,
  };
}

// ─── helpers ─────────────────────────────────────────

function safeJsonArray(v: unknown): unknown[] {
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
// str/nullableStr/asArray/asNum were the record guards before #29. The zod
// shapes above replaced them; only isStr survives, for the envelope-level
// `goal` field which is a plain string and not a record.
