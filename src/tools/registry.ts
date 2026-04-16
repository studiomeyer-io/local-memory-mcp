/**
 * Tool registry — the single source of truth for:
 *   1. The list of tools exposed via MCP (inputSchema in JSON Schema format).
 *   2. The dispatch table that maps tool name → handler.
 *
 * Each tool has a Zod schema for validation + a handler. We convert Zod to
 * JSON Schema inline via a tiny custom converter (no runtime dep on
 * zod-to-json-schema — we only need the basics for our own schemas).
 */
import { z } from 'zod';
import type { ToolResult } from '../lib/types.js';

import { sessionStart, sessionStartSchema, sessionEnd, sessionEndSchema } from './session.js';
import { learn, learnSchema, recall, recallSchema } from './learn.js';
import { search, searchSchema } from './search.js';
import { decide, decideSchema } from './decide.js';
import {
  entityObserve, entityObserveSchema,
  entitySearch, entitySearchSchema,
  entityOpen, entityOpenSchema,
  entityRelate, entityRelateSchema,
} from './entity.js';
import {
  insights, insightsSchema,
  profile, profileSchema,
  guide, guideSchema,
} from './insights.js';

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (input: unknown) => ToolResult | Promise<ToolResult>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'memory_session_start',
    description: 'Start a session. Loads context from previous sessions. Call this FIRST in every conversation.',
    schema: sessionStartSchema,
    handler: (input) => sessionStart(input as z.infer<typeof sessionStartSchema>),
  },
  {
    name: 'memory_session_end',
    description: 'End the current session with an optional summary. Call at the end of each conversation.',
    schema: sessionEndSchema,
    handler: (input) => sessionEnd(input as z.infer<typeof sessionEndSchema>),
  },
  {
    name: 'memory_learn',
    description: 'Store a learning (pattern, mistake, insight, etc.). Gatekeeper prevents duplicates.',
    schema: learnSchema,
    handler: (input) => learn(input as z.infer<typeof learnSchema>),
  },
  {
    name: 'memory_recall',
    description: 'Quick recall: keyword search on learnings, or omit query for most-recent.',
    schema: recallSchema,
    handler: (input) => recall(input as z.infer<typeof recallSchema>),
  },
  {
    name: 'memory_search',
    description: 'Unified search across learnings, decisions, entities, and observations (FTS5 + bm25).',
    schema: searchSchema,
    handler: (input) => search(input as z.infer<typeof searchSchema>),
  },
  {
    name: 'memory_decide',
    description: 'Record a decision with reasoning and alternatives.',
    schema: decideSchema,
    handler: (input) => decide(input as z.infer<typeof decideSchema>),
  },
  {
    name: 'memory_entity_observe',
    description: 'Record a fact about an entity. Creates the entity if missing.',
    schema: entityObserveSchema,
    handler: (input) => entityObserve(input as z.infer<typeof entityObserveSchema>),
  },
  {
    name: 'memory_entity_search',
    description: 'Search entities by name or observation content (FTS5 fuzzy).',
    schema: entitySearchSchema,
    handler: (input) => entitySearch(input as z.infer<typeof entitySearchSchema>),
  },
  {
    name: 'memory_entity_open',
    description: 'Load an entity with all its current observations and relations.',
    schema: entityOpenSchema,
    handler: (input) => entityOpen(input as z.infer<typeof entityOpenSchema>),
  },
  {
    name: 'memory_entity_relate',
    description: 'Create a typed relation (edge) between two entities.',
    schema: entityRelateSchema,
    handler: (input) => entityRelate(input as z.infer<typeof entityRelateSchema>),
  },
  {
    name: 'memory_insights',
    description: 'Stats and reflection: days of memory, totals, category breakdown, entity type breakdown.',
    schema: insightsSchema,
    handler: (input) => insights(input as z.infer<typeof insightsSchema>),
  },
  {
    name: 'memory_profile',
    description: 'Read or write a user profile field (name, role, preferences, …). Stored locally.',
    schema: profileSchema,
    handler: (input) => profile(input as z.infer<typeof profileSchema>),
  },
  {
    name: 'memory_guide',
    description: 'On-demand help. Topics: quickstart, session, search, entities, learn, privacy.',
    schema: guideSchema,
    handler: (input) => guide(input as z.infer<typeof guideSchema>),
  },
];

// ─── Zod → JSON Schema (minimal) ────────────────────
// Claude Desktop needs JSON Schema, not raw Zod. We support the subset our
// tools actually use: object, string, number, boolean, array, enum, optional.

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def: { typeName: string } })._def;

  if (def.typeName === 'ZodObject') {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      const fieldDef = (val as unknown as { _def: { typeName: string } })._def;
      const isOptional = fieldDef.typeName === 'ZodOptional' || fieldDef.typeName === 'ZodDefault';
      properties[key] = zodToJsonSchema(val as z.ZodTypeAny);
      if (!isOptional) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') {
    return zodToJsonSchema((schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType);
  }

  if (def.typeName === 'ZodString') {
    const checks = (def as unknown as { checks?: Array<{ kind: string; value?: number }> }).checks ?? [];
    const result: JsonSchema = { type: 'string' };
    for (const c of checks) {
      if (c.kind === 'min' && c.value !== undefined) result.minLength = c.value;
      if (c.kind === 'max' && c.value !== undefined) result.maxLength = c.value;
    }
    return result;
  }

  if (def.typeName === 'ZodNumber') {
    const checks = (def as unknown as { checks?: Array<{ kind: string; value?: number }> }).checks ?? [];
    const result: JsonSchema = { type: 'number' };
    for (const c of checks) {
      if (c.kind === 'min' && c.value !== undefined) result.minimum = c.value;
      if (c.kind === 'max' && c.value !== undefined) result.maximum = c.value;
      if (c.kind === 'int') result.type = 'integer';
    }
    return result;
  }

  if (def.typeName === 'ZodBoolean') return { type: 'boolean' };

  if (def.typeName === 'ZodArray') {
    const inner = (schema as unknown as { _def: { type: z.ZodTypeAny } })._def.type;
    return { type: 'array', items: zodToJsonSchema(inner) };
  }

  if (def.typeName === 'ZodEnum') {
    const values = (def as unknown as { values: string[] }).values;
    return { type: 'string', enum: values };
  }

  // Fallback — let Claude Desktop show the tool even if the schema is loose
  return { type: 'object' };
}

export function toMcpToolList(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  }));
}

export function getHandler(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
