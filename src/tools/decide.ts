/**
 * Decision logging — strategic choices with reasoning and alternatives.
 *
 * Decisions are treated separately from learnings because they represent
 * "what we chose" rather than "what we learned". They're often revisited
 * and reviewed over time.
 */
import { z } from 'zod';
import { getDb, newId, nowIso } from '../db/client.js';
import type { ToolResult } from '../lib/types.js';

export const decideSchema = z.object({
  title: z.string().min(1).max(200),
  decision: z.string().min(1).max(10000),
  reasoning: z.string().min(1).max(10000),
  alternatives: z.string().max(10000).optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export function decide(input: z.infer<typeof decideSchema>): ToolResult {
  const db = getDb();
  const id = newId();

  db.prepare(
    `INSERT INTO decisions
     (id, date, title, decision, alternatives, reasoning, project, tags_json, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    nowIso(),
    input.title,
    input.decision,
    input.alternatives ?? null,
    input.reasoning,
    input.project ?? null,
    JSON.stringify(input.tags ?? []),
    input.confidence ?? 0.7
  );

  return {
    success: true,
    data: { id },
    message: `Entscheidung "${input.title}" gespeichert.`,
  };
}
