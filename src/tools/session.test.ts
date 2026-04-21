/**
 * Tests for the session-tracking tools.
 *
 * Session semantics:
 *   - session_start creates a row, returns context from the last 3 sessions
 *     with a summary (same-project preferred), total session count and the
 *     5 most recent unarchived learnings.
 *   - session_end marks the current session as ended, stores summary + tasks.
 *     If no sessionId is passed, it closes the most recent open session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-session-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('sessionStart', () => {
  it('creates a new session and returns a uuid', async () => {
    const { sessionStart } = await import('./session.js');
    const result = sessionStart({});
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { sessionId: string; totalSessions: number };
      expect(d.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(d.totalSessions).toBe(1);
    }
  });

  it('totalSessions increments with each start', async () => {
    const { sessionStart } = await import('./session.js');
    const a = sessionStart({});
    const b = sessionStart({});
    const c = sessionStart({});
    if (a.success && b.success && c.success) {
      expect((a.data as { totalSessions: number }).totalSessions).toBe(1);
      expect((b.data as { totalSessions: number }).totalSessions).toBe(2);
      expect((c.data as { totalSessions: number }).totalSessions).toBe(3);
    }
  });

  it('returns empty previousSessions on a fresh db', async () => {
    const { sessionStart } = await import('./session.js');
    const result = sessionStart({});
    if (result.success) {
      const d = result.data as { previousSessions: unknown[] };
      expect(d.previousSessions).toEqual([]);
    }
  });

  it('returns only previous sessions that have a summary', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    const first = sessionStart({});
    const second = sessionStart({});
    // Close only the second one with a summary.
    if (first.success && second.success) {
      sessionEnd({
        sessionId: (second.data as { sessionId: string }).sessionId,
        summary: 'wrapped up',
      });
    }

    const third = sessionStart({});
    if (third.success) {
      const d = third.data as { previousSessions: Array<{ id: string; summary: string | null }> };
      // Only the session with a summary should be included.
      expect(d.previousSessions.length).toBe(1);
      expect(d.previousSessions[0]?.summary).toBe('wrapped up');
    }
  });

  it('prefers same-project sessions when ordering previousSessions', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    // Close one session on project A, one on project B, one on A again (newest).
    const a1 = sessionStart({ project: 'alpha' });
    if (a1.success) sessionEnd({ sessionId: (a1.data as { sessionId: string }).sessionId, summary: 'alpha early' });
    const b1 = sessionStart({ project: 'beta' });
    if (b1.success) sessionEnd({ sessionId: (b1.data as { sessionId: string }).sessionId, summary: 'beta only' });
    const a2 = sessionStart({ project: 'alpha' });
    if (a2.success) sessionEnd({ sessionId: (a2.data as { sessionId: string }).sessionId, summary: 'alpha latest' });

    // Now open a new session on 'alpha' — the first two previousSessions should
    // belong to project 'alpha', not 'beta'.
    const current = sessionStart({ project: 'alpha' });
    if (current.success) {
      const d = current.data as { previousSessions: Array<{ project: string | null }> };
      expect(d.previousSessions.length).toBeGreaterThanOrEqual(2);
      expect(d.previousSessions[0]?.project).toBe('alpha');
      expect(d.previousSessions[1]?.project).toBe('alpha');
    }
  });

  it('caps previousSessions at 3 even when many historical sessions exist', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    for (let i = 0; i < 6; i++) {
      const s = sessionStart({});
      if (s.success) sessionEnd({ sessionId: (s.data as { sessionId: string }).sessionId, summary: `run ${i}` });
    }
    const current = sessionStart({});
    if (current.success) {
      const d = current.data as { previousSessions: unknown[] };
      expect(d.previousSessions.length).toBe(3);
    }
  });

  it('includes the 5 most recent unarchived learnings in recentLearnings', async () => {
    const { sessionStart } = await import('./session.js');
    const { learn } = await import('./learn.js');
    for (let i = 0; i < 7; i++) {
      learn({ category: 'pattern', content: `entry ${i}` });
    }
    const result = sessionStart({});
    if (result.success) {
      const d = result.data as { recentLearnings: Array<{ content: string }> };
      expect(d.recentLearnings.length).toBe(5);
    }
  });

  it('excludes archived learnings from recentLearnings', async () => {
    const { sessionStart } = await import('./session.js');
    const { learn } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    learn({ category: 'pattern', content: 'keeper one' });
    const archived = learn({ category: 'pattern', content: 'archived one' });
    if (archived.success) {
      getDb()
        .prepare('UPDATE learnings SET archived = 1 WHERE id = ?')
        .run((archived.data as { id: string }).id);
    }
    const result = sessionStart({});
    if (result.success) {
      const d = result.data as { recentLearnings: Array<{ content: string }> };
      const contents = d.recentLearnings.map((r) => r.content);
      expect(contents).toContain('keeper one');
      expect(contents).not.toContain('archived one');
    }
  });

  it('includes the project in the message when one is passed', async () => {
    const { sessionStart } = await import('./session.js');
    const result = sessionStart({ project: 'my-proj' });
    if (result.success) {
      expect(result.message).toContain('my-proj');
    }
  });

  it('produces a message without project when none is passed', async () => {
    const { sessionStart } = await import('./session.js');
    const result = sessionStart({});
    if (result.success) {
      // The message should still exist but not mention an empty project.
      expect(result.message).not.toContain('Projekt:');
    }
  });
});

describe('sessionEnd', () => {
  it('closes a session by explicit id and stores the summary', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    const { getDb } = await import('../db/client.js');
    const start = sessionStart({});
    if (!start.success) throw new Error('setup failed');
    const id = (start.data as { sessionId: string }).sessionId;
    const end = sessionEnd({ sessionId: id, summary: 'all done' });
    expect(end.success).toBe(true);

    const row = getDb().prepare('SELECT ended_at, summary FROM sessions WHERE id = ?').get(id) as {
      ended_at: string | null;
      summary: string | null;
    };
    expect(row.ended_at).not.toBeNull();
    expect(row.summary).toBe('all done');
  });

  it('serialises the tasks array as JSON in tasks_json', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    const { getDb } = await import('../db/client.js');
    const start = sessionStart({});
    if (!start.success) throw new Error('setup failed');
    const id = (start.data as { sessionId: string }).sessionId;
    sessionEnd({ sessionId: id, tasks: ['fix bug', 'write tests', 'ship it'] });

    const row = getDb().prepare('SELECT tasks_json FROM sessions WHERE id = ?').get(id) as {
      tasks_json: string | null;
    };
    expect(row.tasks_json).toBeTruthy();
    const parsed = JSON.parse(row.tasks_json!);
    expect(parsed).toEqual(['fix bug', 'write tests', 'ship it']);
  });

  it('closes the most recent open session when no sessionId is passed', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    const { getDb } = await import('../db/client.js');
    const first = sessionStart({});
    // Small pause so started_at ordering is deterministic even at second-resolution.
    if (first.success) {
      getDb()
        .prepare("UPDATE sessions SET started_at = datetime('now', '-10 seconds') WHERE id = ?")
        .run((first.data as { sessionId: string }).sessionId);
    }
    const second = sessionStart({});
    const closed = sessionEnd({ summary: 'auto-close' });
    expect(closed.success).toBe(true);
    if (closed.success && second.success) {
      expect((closed.data as { sessionId: string }).sessionId).toBe(
        (second.data as { sessionId: string }).sessionId,
      );
    }
  });

  it('returns NO_ACTIVE_SESSION when there is no open session and no id is passed', async () => {
    const { sessionEnd } = await import('./session.js');
    const result = sessionEnd({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NO_ACTIVE_SESSION');
    }
  });

  it('does not reopen an already-closed session — it just re-stamps ended_at/summary', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    const { getDb } = await import('../db/client.js');
    const start = sessionStart({});
    if (!start.success) throw new Error('setup failed');
    const id = (start.data as { sessionId: string }).sessionId;
    sessionEnd({ sessionId: id, summary: 'first close' });
    sessionEnd({ sessionId: id, summary: 'second close' });
    const row = getDb().prepare('SELECT summary FROM sessions WHERE id = ?').get(id) as {
      summary: string;
    };
    expect(row.summary).toBe('second close');
  });

  it('leaves tasks_json = NULL when no tasks array is supplied', async () => {
    const { sessionStart, sessionEnd } = await import('./session.js');
    const { getDb } = await import('../db/client.js');
    const start = sessionStart({});
    if (!start.success) throw new Error('setup failed');
    const id = (start.data as { sessionId: string }).sessionId;
    sessionEnd({ sessionId: id, summary: 'only summary' });
    const row = getDb().prepare('SELECT tasks_json FROM sessions WHERE id = ?').get(id) as {
      tasks_json: string | null;
    };
    expect(row.tasks_json).toBeNull();
  });
});

describe('session schemas', () => {
  it('sessionStartSchema accepts an empty object', async () => {
    const { sessionStartSchema } = await import('./session.js');
    expect(sessionStartSchema.safeParse({}).success).toBe(true);
  });

  it('sessionEndSchema accepts an empty object (auto-close path)', async () => {
    const { sessionEndSchema } = await import('./session.js');
    expect(sessionEndSchema.safeParse({}).success).toBe(true);
  });

  it('sessionEndSchema rejects a tasks field that is not an array', async () => {
    const { sessionEndSchema } = await import('./session.js');
    expect(sessionEndSchema.safeParse({ tasks: 'not an array' }).success).toBe(false);
  });
});
