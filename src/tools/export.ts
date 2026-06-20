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
import { getDb, nowIso } from '../db/client.js';
import { prepareEmbeddingBatch, writeEmbeddingSync } from '../db/vector.js';
import { decisionEmbeddingText } from './decide.js';
import { logger } from '../lib/logger.js';
import type { ToolResult } from '../lib/types.js';

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
    message: `Export: ${total} Datensätze (${learnings.length} learnings, ${decisions.length} decisions, ${entities.length} entities, ${observations.length} observations, ${relations.length} relations${includeSessions ? `, ${sessions.length} sessions` : ''}). Embeddings werden beim Import neu berechnet. Dieses Envelope ist auch von memory.studiomeyer.io importierbar.`,
  };
}

// ─── import ──────────────────────────────────────────

// The envelope is validated structurally inside the handler rather than via a
// giant brittle Zod schema — this keeps us forgiving of envelopes produced by
// the SaaS side or a future exporter version, while still rejecting garbage.
export const memoryImportSchema = z.object({
  data: z.record(z.unknown()),
  mode: z.enum(['merge']).optional(), // reserved; only additive merge is supported
});

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

  const arr = (k: string): Array<Record<string, unknown>> =>
    Array.isArray(env[k]) ? (env[k] as Array<Record<string, unknown>>) : [];
  const data: ImportArrays = {
    learnings: arr('learnings'),
    decisions: arr('decisions'),
    entities: arr('entities'),
    observations: arr('observations'),
    relations: arr('relations'),
    sessions: arr('sessions'),
  };

  // Phase 1 (async, no lock): re-embed all content-bearing rows in parallel.
  // We key vectors by source id so the sync phase can attach them after a
  // successful insert. Rows whose embedding fails (vec disabled / transient)
  // simply land without a vector — FTS5 still indexes them via the triggers.
  // ids are UUIDs so a single id-keyed map can't collide across types; this
  // also matches the embeddings table where content_id is the PK across types.
  // The embed-job filters MIRROR the Phase-2 insert guards exactly, so we never
  // spend inference on a row that will be skipped as malformed (R2 FINDING-B).
  const embedJobs: Array<{ id: string; text: string }> = [];
  for (const l of data.learnings) if (isStr(l.id) && isStr(l.category) && isStr(l.content)) embedJobs.push({ id: l.id, text: l.content });
  // Decisions reuse the SAME embedding text as decide() (title+decision+
  // reasoning+alternatives) so a round-tripped decision keeps its native vector.
  for (const d of data.decisions) if (isStr(d.id) && isStr(d.title) && isStr(d.decision) && isStr(d.reasoning)) embedJobs.push({ id: d.id, text: decisionEmbeddingText(d) });
  for (const o of data.observations) if (isStr(o.id) && isStr(o.entityId) && isStr(o.content)) embedJobs.push({ id: o.id, text: o.content });
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
    malformed: 0,
  };

  // Phase 2 (sync, single transaction): FK-safe insert order. Either the whole
  // import commits or it rolls back — no half-imported graph.
  const entityExists = db.prepare('SELECT 1 FROM entities WHERE id = ? LIMIT 1');
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1');

  const tx = db.transaction(() => {
    // Profile + goal — additive only (never clobber an existing local profile).
    if (env.profile && typeof env.profile === 'object') {
      const ins = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
      for (const [k, v] of Object.entries(env.profile as Record<string, unknown>)) {
        if (typeof v === 'string') {
          const info = ins.run(`profile_${k}`, v);
          if (info.changes > 0) counts.profileFields++;
        }
      }
    }
    if (isStr(env.goal)) {
      db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('current_goal', env.goal);
    }

    // 1) Sessions
    const sIns = db.prepare(
      `INSERT OR IGNORE INTO sessions (id, started_at, ended_at, project, summary, tasks_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of data.sessions) {
      if (!isStr(s.id)) { skipped.malformed++; continue; }
      const info = sIns.run(
        s.id,
        str(s.startedAt) || nowIso(),
        nullableStr(s.endedAt),
        nullableStr(s.project),
        nullableStr(s.summary),
        JSON.stringify(asArray(s.tasks))
      );
      if (info.changes > 0) counts.sessions++;
    }

    // 2) Entities (dedupe on PK and on UNIQUE(name, entity_type))
    const eIns = db.prepare(
      `INSERT OR IGNORE INTO entities (id, name, entity_type, created_at, updated_at, summary, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of data.entities) {
      if (!isStr(e.id) || !isStr(e.name) || !isStr(e.entityType)) { skipped.malformed++; continue; }
      const info = eIns.run(
        e.id,
        e.name,
        e.entityType,
        str(e.createdAt) || nowIso(),
        str(e.updatedAt) || nowIso(),
        nullableStr(e.summary),
        asNum(e.confidence, 0.7)
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
    for (const o of data.observations) {
      if (!isStr(o.id) || !isStr(o.entityId) || !isStr(o.content)) { skipped.malformed++; continue; }
      if (!entityExists.get(o.entityId)) { skipped.observationsMissingEntity++; continue; }
      const sessId = isStr(o.sessionId) && sessionExists.get(o.sessionId) ? o.sessionId : null;
      const info = oIns.run(
        o.id,
        o.entityId,
        o.content,
        nullableStr(o.source),
        sessId,
        str(o.validFrom) || nowIso(),
        nullableStr(o.validTo),
        asNum(o.confidence, 0.7),
        str(o.createdAt) || nowIso()
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
    for (const rel of data.relations) {
      if (!isStr(rel.id) || !isStr(rel.fromEntityId) || !isStr(rel.toEntityId) || !isStr(rel.relationType)) {
        skipped.malformed++;
        continue;
      }
      if (!entityExists.get(rel.fromEntityId) || !entityExists.get(rel.toEntityId)) {
        skipped.relationsMissingEndpoint++;
        continue;
      }
      const info = rIns.run(
        rel.id,
        rel.fromEntityId,
        rel.toEntityId,
        rel.relationType,
        asNum(rel.weight, 1.0),
        str(rel.createdAt) || nowIso()
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
    for (const l of data.learnings) {
      if (!isStr(l.id) || !isStr(l.category) || !isStr(l.content)) { skipped.malformed++; continue; }
      const info = lIns.run(
        l.id,
        str(l.date) || nowIso(),
        l.category,
        l.content,
        nullableStr(l.project),
        JSON.stringify(asArray(l.tags)),
        asNum(l.usageCount, 0),
        nullableStr(l.lastUsed),
        asNum(l.confidence, 0.7),
        nullableStr(l.source),
        asNum(l.verified, 0),
        nullableStr(l.verifiedAt),
        asNum(l.archived, 0),
        nullableStr(l.archivedAt),
        l.importance === null || l.importance === undefined ? null : asNum(l.importance, 0),
        str(l.lifecycleState) || 'active',
        str(l.memoryType) || 'semantic'
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
    for (const d of data.decisions) {
      // reasoning is NOT NULL in the schema — a decision without it is malformed
      // (would insert '' and degrade the FTS body). Skip rather than corrupt. C1.
      if (!isStr(d.id) || !isStr(d.title) || !isStr(d.decision) || !isStr(d.reasoning)) { skipped.malformed++; continue; }
      const info = dIns.run(
        d.id,
        str(d.date) || nowIso(),
        d.title,
        d.decision,
        nullableStr(d.alternatives),
        str(d.reasoning),
        nullableStr(d.project),
        JSON.stringify(asArray(d.tags)),
        asNum(d.confidence, 0.7),
        nullableStr(d.source),
        asNum(d.verified, 0),
        nullableStr(d.verifiedAt)
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
    message: `Import: ${totalImported} neue Datensätze übernommen (additiv, Duplikate übersprungen).${totalSkipped > 0 ? ` ${totalSkipped} übersprungen (fehlende Referenzen/fehlerhaft).` : ''}`,
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
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
