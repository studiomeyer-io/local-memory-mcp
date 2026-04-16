/**
 * Insights, health, profile, guide — the "reflective" tools.
 *
 * insights: stats + what Claude has learned about the user
 * health:   DB size, counts, integrity
 * profile:  read/write user profile (stored in meta)
 * goal:     current goal (stored in meta)
 * guide:    embedded how-to text, per topic
 */
import { z } from 'zod';
import { getDb } from '../db/client.js';
import type { ToolResult } from '../lib/types.js';

// ─── insights ────────────────────────────────────────

export const insightsSchema = z.object({
  project: z.string().optional(),
});

export function insights(input: z.infer<typeof insightsSchema>): ToolResult {
  const db = getDb();
  const projectFilter = input.project ? 'WHERE project = ?' : '';
  const projectArgs = input.project ? [input.project] : [];

  const totalSessions = (db.prepare(`SELECT COUNT(*) as c FROM sessions ${projectFilter}`).get(...projectArgs) as { c: number }).c;
  const totalLearnings = (db.prepare(`SELECT COUNT(*) as c FROM learnings WHERE archived = 0 ${projectFilter ? 'AND project = ?' : ''}`).get(...projectArgs) as { c: number }).c;
  const totalDecisions = (db.prepare(`SELECT COUNT(*) as c FROM decisions ${projectFilter}`).get(...projectArgs) as { c: number }).c;
  const totalEntities = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;

  const categoryBreakdown = db
    .prepare(
      `SELECT category, COUNT(*) as count
       FROM learnings
       WHERE archived = 0 ${projectFilter ? 'AND project = ?' : ''}
       GROUP BY category
       ORDER BY count DESC`
    )
    .all(...projectArgs);

  const entityTypeBreakdown = db
    .prepare('SELECT entity_type, COUNT(*) as count FROM entities GROUP BY entity_type ORDER BY count DESC')
    .all();

  // How many days of memory? First session → now.
  const firstSession = db.prepare('SELECT MIN(started_at) as first FROM sessions').get() as { first: string | null };
  const daysOfMemory = firstSession.first
    ? Math.max(1, Math.floor((Date.now() - new Date(firstSession.first).getTime()) / 86400000))
    : 0;

  return {
    success: true,
    data: {
      daysOfMemory,
      totalSessions,
      totalLearnings,
      totalDecisions,
      totalEntities,
      categoryBreakdown,
      entityTypeBreakdown,
    },
    message: `Claude kennt dich seit ${daysOfMemory} Tagen. Er erinnert sich an ${totalLearnings} Dinge.`,
  };
}

// ─── health ──────────────────────────────────────────

export function health(): ToolResult {
  const db = getDb();

  const integrity = db.pragma('integrity_check', { simple: true });
  const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0;
  const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 0;
  const sizeBytes = pageCount * pageSize;

  return {
    success: true,
    data: {
      integrity,
      sizeBytes,
      sizeMB: Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
      schemaVersion: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? 'unknown',
      firstRunAt: (db.prepare("SELECT value FROM meta WHERE key = 'first_run_at'").get() as { value: string } | undefined)?.value ?? null,
    },
    message: integrity === 'ok' ? 'Alles gesund.' : `Integrity issue: ${integrity}`,
  };
}

// ─── profile ─────────────────────────────────────────

export const profileSchema = z.object({
  action: z.enum(['get', 'set']),
  field: z.string().optional(),
  value: z.string().optional(),
});

export function profile(input: z.infer<typeof profileSchema>): ToolResult {
  const db = getDb();

  if (input.action === 'get') {
    if (input.field) {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(`profile_${input.field}`) as { value: string } | undefined;
      return { success: true, data: { field: input.field, value: row?.value ?? null } };
    }
    // Return all profile fields
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 'profile_%'")
      .all() as Array<{ key: string; value: string }>;
    const profile: Record<string, string> = {};
    for (const r of rows) profile[r.key.replace(/^profile_/, '')] = r.value;
    return { success: true, data: profile };
  }

  // set
  if (!input.field || input.value === undefined) {
    return { success: false, error: 'field and value required for set.', code: 'MISSING_ARGS' };
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    `profile_${input.field}`,
    input.value
  );
  return { success: true, data: { field: input.field, value: input.value }, message: 'Profil aktualisiert.' };
}

// ─── goal ────────────────────────────────────────────

export const goalSchema = z.object({
  action: z.enum(['get', 'set', 'clear']),
  goal: z.string().optional(),
});

export function goal(input: z.infer<typeof goalSchema>): ToolResult {
  const db = getDb();

  if (input.action === 'get') {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'current_goal'").get() as { value: string } | undefined;
    return { success: true, data: { goal: row?.value ?? null } };
  }
  if (input.action === 'set') {
    if (!input.goal) return { success: false, error: 'goal required for set.', code: 'MISSING_ARGS' };
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('current_goal', input.goal);
    return { success: true, data: { goal: input.goal }, message: 'Ziel gesetzt.' };
  }
  db.prepare("DELETE FROM meta WHERE key = 'current_goal'").run();
  return { success: true, data: { goal: null }, message: 'Ziel gelöscht.' };
}

// ─── guide ───────────────────────────────────────────

const GUIDE_TOPICS: Record<string, string> = {
  quickstart: `# Local Memory — Quickstart

This MCP server gives your AI assistant persistent memory across conversations. All data stays on your machine in a single SQLite file.

## Basic flow

1. Call \`memory_session_start\` at the beginning of each conversation to load context.
2. As the conversation progresses, call \`memory_learn\` to store knowledge and \`memory_entity_observe\` to add facts about people/projects/tools.
3. Call \`memory_search\` or \`memory_recall\` to find past knowledge.
4. Call \`memory_session_end\` at the end to store a summary for next time.

## Philosophy

- **Local-first** — everything lives in a SQLite file on your machine. No cloud, no API keys.
- **Works everywhere** — Claude Desktop, Claude Code, Cursor, Codex, Continue.
- **Knowledge Graph** — not just flat text. Entities, observations, relations.
- **Duplicate guard** — the gatekeeper prevents storing the same thing twice.`,

  session: `# Sessions

A session is one conversation window. It captures context, goals, and outcomes.

- \`session_start\` — begin a session, load context from the last 3 sessions.
- \`session_end\` — close the current session with a summary.

Tip: let \`session_end\` auto-detect the active session — no sessionId argument needed.`,

  search: `# Search

Use \`search\` for broad queries across everything (learnings, decisions, entities, observations).
Use \`recall\` for quick keyword search on learnings only, or without arguments to get the most recent.

FTS5 uses bm25 ranking. Short queries work. Multi-word queries are AND-combined.`,

  entities: `# Knowledge Graph

Entities are nodes: people, projects, companies, tools. Observations are facts about them. Relations are edges.

- \`entity_observe\` — record a fact about an entity (auto-creates if missing).
- \`entity_search\` — fuzzy search across entities and their observations.
- \`entity_open\` — load an entity with all its observations and relations.
- \`entity_relate\` — create a typed edge between two entities.`,

  learn: `# Learnings

Learnings are facts, patterns, insights that should persist across sessions.

- Categories: pattern, mistake, insight, research, architecture, infrastructure, tool, workflow, performance, security.
- Memory type: episodic ("it happened") or semantic ("it is true"). Auto-classified.
- Duplicate handling: exact duplicates are skipped and bump the usage counter; very similar ones may be merged.`,

  privacy: `# Privacy

Your memory file lives at:
- macOS: ~/Library/Application Support/local-memory-mcp/memory.sqlite
- Linux: ~/.local/share/local-memory-mcp/memory.sqlite
- Windows: %APPDATA%\\local-memory-mcp\\memory.sqlite

Nothing is sent over the network. Ever. No telemetry, no phone-home, no account.
You can back up, copy, delete, or move the file at any time.
Override the path: set MEMORY_DB_PATH=/your/preferred/path.sqlite`,
};

export const guideSchema = z.object({
  topic: z.string().optional(),
});

export function guide(input: z.infer<typeof guideSchema>): ToolResult {
  if (!input.topic) {
    return {
      success: true,
      data: {
        topics: Object.keys(GUIDE_TOPICS),
        hint: 'Call guide({topic: "quickstart"}) for specific help.',
      },
    };
  }
  const content = GUIDE_TOPICS[input.topic];
  if (!content) {
    return {
      success: false,
      error: `Unknown topic: ${input.topic}. Available: ${Object.keys(GUIDE_TOPICS).join(', ')}`,
      code: 'UNKNOWN_TOPIC',
    };
  }
  return { success: true, data: { topic: input.topic, content } };
}
