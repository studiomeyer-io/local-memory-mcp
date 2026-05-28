/**
 * Decision logging — strategic choices with reasoning and alternatives.
 *
 * Decisions are treated separately from learnings because they represent
 * "what we chose" rather than "what we learned". They're often revisited
 * and reviewed over time.
 *
 * v2.0.0+: a decision's embedding is the title + decision + reasoning
 * concatenated, so a search for "Postgres vs SQLite" finds a decision
 * whose title is "Database choice" but whose reasoning text discusses both.
 *
 * F4 fix (Critic R1): the embedding is computed outside any transaction,
 * then the row insert + embedding insert commit atomically together.
 */
import { z } from 'zod';
import { getDb, newId, nowIso } from '../db/client.js';
import { prepareEmbedding, writeEmbeddingSync } from '../db/vector.js';
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

export async function decide(input: z.infer<typeof decideSchema>): Promise<ToolResult> {
  const db = getDb();
  const id = newId();

  // Encode the *whole* decision so we can match by reasoning fragments too.
  const embeddingText = [
    input.title,
    input.decision,
    input.reasoning,
    input.alternatives ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  const vec = await prepareEmbedding(embeddingText);

  const tx = db.transaction(() => {
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
    writeEmbeddingSync(db, id, 'decision', vec);
  });
  tx();

  return {
    success: true,
    data: { id },
    message: `Entscheidung "${input.title}" gespeichert.`,
  };
}
