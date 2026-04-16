/**
 * Entity (Knowledge Graph) tools.
 *
 * Entities are nodes: Person, Project, Company, Tool, Concept, etc.
 * Observations are bi-temporal facts about an entity.
 * Relations are typed, directed edges between entities.
 */
import { z } from 'zod';
import { getDb, newId, nowIso, escapeFtsQuery } from '../db/client.js';
import type { ToolResult } from '../lib/types.js';

// ─── entity_create ───────────────────────────────────

export const entityCreateSchema = z.object({
  name: z.string().min(1).max(200),
  entityType: z.string().min(1).max(50),
  summary: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export function entityCreate(input: z.infer<typeof entityCreateSchema>): ToolResult {
  const db = getDb();

  // Upsert: if name+type already exists, return existing
  const existing = db
    .prepare('SELECT id FROM entities WHERE name = ? AND entity_type = ?')
    .get(input.name, input.entityType) as { id: string } | undefined;

  if (existing) {
    if (input.summary) {
      db.prepare('UPDATE entities SET summary = ?, updated_at = ? WHERE id = ?').run(
        input.summary,
        nowIso(),
        existing.id
      );
    }
    return {
      success: true,
      data: { id: existing.id, action: 'existing' },
      message: `Entity "${input.name}" existiert bereits.`,
    };
  }

  const id = newId();
  db.prepare(
    `INSERT INTO entities (id, name, entity_type, summary, confidence)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.name, input.entityType, input.summary ?? null, input.confidence ?? 0.7);

  return {
    success: true,
    data: { id, action: 'created' },
    message: `Entity "${input.name}" (${input.entityType}) angelegt.`,
  };
}

// ─── entity_observe ──────────────────────────────────

export const entityObserveSchema = z.object({
  entityId: z.string().optional(),
  entityName: z.string().optional(),
  entityType: z.string().optional(),
  content: z.string().min(1).max(5000),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export function entityObserve(input: z.infer<typeof entityObserveSchema>): ToolResult {
  const db = getDb();

  // Resolve entity id (either by id, or by name+type — create if missing)
  let entityId = input.entityId;
  if (!entityId) {
    if (!input.entityName || !input.entityType) {
      return {
        success: false,
        error: 'entityId OR (entityName AND entityType) required.',
        code: 'MISSING_ENTITY_REF',
      };
    }
    const created = entityCreate({
      name: input.entityName,
      entityType: input.entityType,
    });
    if (!created.success) return created;
    entityId = (created.data as { id: string }).id;
  }

  const id = newId();
  db.prepare(
    `INSERT INTO entity_observations (id, entity_id, content, source, confidence)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, entityId, input.content, input.source ?? null, input.confidence ?? 0.7);

  // Bump entity updated_at
  db.prepare('UPDATE entities SET updated_at = ? WHERE id = ?').run(nowIso(), entityId);

  return {
    success: true,
    data: { observationId: id, entityId },
    message: 'Beobachtung gespeichert.',
  };
}

// ─── entity_search ───────────────────────────────────

export const entitySearchSchema = z.object({
  query: z.string().min(1),
  entityType: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function entitySearch(input: z.infer<typeof entitySearchSchema>): ToolResult {
  const db = getDb();
  const limit = input.limit ?? 10;

  // First try FTS5 across entity + observation text
  try {
    const fts = escapeFtsQuery(input.query);
    const typeFilter = input.entityType ? 'AND e.entity_type = ?' : '';
    const sql = `
      SELECT DISTINCT e.id, e.name, e.entity_type, e.summary, e.updated_at,
             MIN(bm25(search_fts)) AS rank
      FROM search_fts
      JOIN entities e ON (
        (search_fts.content_type = 'entity' AND search_fts.content_id = e.id) OR
        (search_fts.content_type = 'observation' AND search_fts.content_id IN
          (SELECT id FROM entity_observations WHERE entity_id = e.id))
      )
      WHERE search_fts MATCH ? ${typeFilter}
      GROUP BY e.id
      ORDER BY rank
      LIMIT ?
    `;
    const args: unknown[] = [fts];
    if (input.entityType) args.push(input.entityType);
    args.push(limit);
    const rows = db.prepare(sql).all(...args);
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  } catch {
    // Fallback: LIKE on name
    const rows = db
      .prepare(
        `SELECT id, name, entity_type, summary, updated_at
         FROM entities
         WHERE name LIKE ? ${input.entityType ? 'AND entity_type = ?' : ''}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...(input.entityType ? [`%${input.query}%`, input.entityType, limit] : [`%${input.query}%`, limit]));
    return { success: true, data: { results: rows, count: (rows as unknown[]).length } };
  }
}

// ─── entity_open ─────────────────────────────────────

export const entityOpenSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  entityType: z.string().optional(),
});

export function entityOpen(input: z.infer<typeof entityOpenSchema>): ToolResult {
  const db = getDb();

  let entity: {
    id: string;
    name: string;
    entity_type: string;
    summary: string | null;
    created_at: string;
    updated_at: string;
    confidence: number;
  } | undefined;

  if (input.id) {
    entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(input.id) as typeof entity;
  } else if (input.name) {
    const sql = input.entityType
      ? 'SELECT * FROM entities WHERE name = ? AND entity_type = ?'
      : 'SELECT * FROM entities WHERE name = ? LIMIT 1';
    const args = input.entityType ? [input.name, input.entityType] : [input.name];
    entity = db.prepare(sql).get(...args) as typeof entity;
  }

  if (!entity) {
    return { success: false, error: 'Entity not found.', code: 'NOT_FOUND' };
  }

  const observations = db
    .prepare(
      `SELECT id, content, source, valid_from, valid_to, confidence, created_at
       FROM entity_observations
       WHERE entity_id = ? AND valid_to IS NULL
       ORDER BY created_at DESC`
    )
    .all(entity.id);

  const relations = db
    .prepare(
      `SELECT r.relation_type, r.weight, e.id, e.name, e.entity_type, 'out' AS direction
       FROM entity_relations r
       JOIN entities e ON e.id = r.to_entity_id
       WHERE r.from_entity_id = ?
       UNION ALL
       SELECT r.relation_type, r.weight, e.id, e.name, e.entity_type, 'in' AS direction
       FROM entity_relations r
       JOIN entities e ON e.id = r.from_entity_id
       WHERE r.to_entity_id = ?`
    )
    .all(entity.id, entity.id);

  return {
    success: true,
    data: { entity, observations, relations },
  };
}

// ─── entity_relate ───────────────────────────────────

export const entityRelateSchema = z.object({
  fromEntityId: z.string(),
  toEntityId: z.string(),
  relationType: z.string().min(1).max(50),
  weight: z.number().min(0).max(1).optional(),
});

export function entityRelate(input: z.infer<typeof entityRelateSchema>): ToolResult {
  const db = getDb();
  const id = newId();

  try {
    db.prepare(
      `INSERT INTO entity_relations (id, from_entity_id, to_entity_id, relation_type, weight)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, input.fromEntityId, input.toEntityId, input.relationType, input.weight ?? 1.0);
    return { success: true, data: { id }, message: 'Beziehung angelegt.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE')) {
      return { success: false, error: 'Diese Beziehung existiert bereits.', code: 'DUPLICATE_RELATION' };
    }
    return { success: false, error: msg, code: 'INSERT_FAILED' };
  }
}

// ─── entity_delete ───────────────────────────────────

export const entityDeleteSchema = z.object({
  id: z.string(),
});

export function entityDelete(input: z.infer<typeof entityDeleteSchema>): ToolResult {
  const db = getDb();
  const result = db.prepare('DELETE FROM entities WHERE id = ?').run(input.id);
  if (result.changes === 0) {
    return { success: false, error: 'Entity not found.', code: 'NOT_FOUND' };
  }
  return { success: true, data: { id: input.id }, message: 'Entity und zugehörige Daten gelöscht.' };
}
