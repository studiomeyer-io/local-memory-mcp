/**
 * Session tracking — the entry/exit points for a working session.
 *
 * Philosophy: a session is a conversation window. session_start loads context
 * from the last N sessions so the AI knows where it left off. session_end
 * stores a summary so the next session can pick up.
 */
import { z } from 'zod';
import { getDb, newId, nowIso } from '../db/client.js';
import type { ToolResult } from '../lib/types.js';

// ─── session_start ───────────────────────────────────

export const sessionStartSchema = z.object({
  project: z.string().optional(),
});

export function sessionStart(input: z.infer<typeof sessionStartSchema>): ToolResult {
  const db = getDb();
  const id = newId();
  db.prepare('INSERT INTO sessions (id, started_at, project) VALUES (?, ?, ?)').run(
    id,
    nowIso(),
    input.project ?? null
  );

  // Load context from previous sessions (last 3, same project preferred)
  const prevSessions = db
    .prepare(
      `SELECT id, started_at, ended_at, project, summary
       FROM sessions
       WHERE id != ? AND summary IS NOT NULL
       ORDER BY
         CASE WHEN project = ? THEN 0 ELSE 1 END,
         started_at DESC
       LIMIT 3`
    )
    .all(id, input.project ?? '') as Array<{
    id: string;
    started_at: string;
    ended_at: string | null;
    project: string | null;
    summary: string | null;
  }>;

  // Total session count + recent learnings
  const totalSessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
  const recentLearnings = db
    .prepare(
      `SELECT id, category, content, date
       FROM learnings
       WHERE archived = 0
       ORDER BY date DESC
       LIMIT 5`
    )
    .all() as Array<{ id: string; category: string; content: string; date: string }>;

  return {
    success: true,
    data: {
      sessionId: id,
      totalSessions,
      previousSessions: prevSessions,
      recentLearnings,
    },
    message: `Session #${totalSessions} gestartet.${input.project ? ` Projekt: ${input.project}` : ''}`,
  };
}

// ─── session_end ─────────────────────────────────────

export const sessionEndSchema = z.object({
  sessionId: z.string().optional(),
  summary: z.string().optional(),
  tasks: z.array(z.string()).optional(),
});

export function sessionEnd(input: z.infer<typeof sessionEndSchema>): ToolResult {
  const db = getDb();

  // If no sessionId provided, use the most recent open session
  let targetId = input.sessionId;
  if (!targetId) {
    const latest = db
      .prepare('SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
      .get() as { id: string } | undefined;
    if (!latest) {
      return { success: false, error: 'No active session to end.', code: 'NO_ACTIVE_SESSION' };
    }
    targetId = latest.id;
  }

  db.prepare('UPDATE sessions SET ended_at = ?, summary = ?, tasks_json = ? WHERE id = ?').run(
    nowIso(),
    input.summary ?? null,
    input.tasks ? JSON.stringify(input.tasks) : null,
    targetId
  );

  return {
    success: true,
    data: { sessionId: targetId },
    message: 'Session beendet.',
  };
}
