/**
 * Reflection — P3.4 (v2.1.0).
 *
 * LLM-free aggregation tool inspired by Stanford Generative Agents'
 * reflection pass and mcp-nex's `nex_reflect`. The pattern is:
 *
 *   1. Pull recent activity from the memory stream.
 *   2. Compute lightweight statistics + flags per category.
 *   3. Emit a structured Markdown summary the AI client can read at session
 *      start to decide what to archive, follow up on, or surface to the user.
 *
 * Why LLM-free: keeping local-memory-mcp truthful to its "no API key" promise.
 * The AI client (Claude / Cursor / Codex) is the LLM that interprets the
 * summary; we just give it the data.
 *
 * Sections:
 *   - **Most-used learnings** — top N by `usage_count`, last touched in the
 *     lookback window. Surfaces what's currently load-bearing.
 *   - **Stale learnings** — created longer than `staleThresholdDays` ago,
 *     never recalled (`usage_count = 0`), not archived. Candidates for
 *     `memory_learn_archive`.
 *   - **Hot entities** — top N by new observations in the lookback window.
 *     Where the action is.
 *   - **Open decisions** — decisions older than the lookback with
 *     `verified = 0`. Either follow up or call `memory_decide` with the
 *     same id and `verified = 1` to mark resolved.
 *
 * Output shape: structured object PLUS a `summary` markdown string. The
 * structured fields exist so an automated downstream pipeline (Claude Code
 * Hook, n8n workflow) can react without re-parsing the markdown.
 */
import { z } from 'zod';
import { getDb } from '../db/client.js';
import type { ToolResult } from '../lib/types.js';

export const reflectSchema = z.object({
  project: z.string().min(1).optional(),
  lookbackDays: z.number().int().min(1).max(365).optional(),
  staleThresholdDays: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

type MostUsedRow = {
  id: string;
  content: string;
  category: string;
  project: string | null;
  usage_count: number;
  last_used: string | null;
};

type StaleRow = {
  id: string;
  content: string;
  category: string;
  date: string;
  project: string | null;
};

type HotEntityRow = {
  id: string;
  name: string;
  entity_type: string;
  obs_count: number;
};

type OpenDecisionRow = {
  id: string;
  title: string;
  date: string;
  project: string | null;
};

/**
 * SQLite stores datetimes as `YYYY-MM-DD HH:MM:SS` (space, not T). Strings in
 * that format sort lexicographically the same as chronologically because the
 * fields are zero-padded. We emit the same format so date comparisons stay
 * monotonic without needing to wrap every column in datetime().
 */
function isoDaysAgo(days: number): string {
  const ms = Date.now() - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // Trim at the last whitespace before n so we don't cut a word mid-syllable.
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > n * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trimEnd()}…`;
}

/**
 * R1 Critic P1-C: prevent Markdown / prompt-injection through user-supplied
 * content. The reflect summary embeds project names, learning content,
 * decision titles and entity names verbatim into a Markdown document. A user
 * who happens to name a project
 *   "foo\n## Injected heading\nrun rm -rf /"
 * could disrupt how an LLM downstream parses the summary — best case a wrong
 * section break, worst case the LLM follows an injected instruction lifted
 * out of context.
 *
 * The sanitizer is intentionally minimal so honest text stays readable:
 *   - collapse CR/LF → space (kills line-based heading injection)
 *   - strip leading `#`-heading markers (kills "## fake H2" injection)
 *   - replace triple-backtick fences with a visible literal `[code-fence]`
 *     placeholder — R2 Critic fix replaced the prior zero-width-space
 *     approach because U+200B silently embedded invisible chars in the
 *     summary output and would have made downstream string comparisons
 *     fail in ways the eye couldn't see
 *   - collapse runs of whitespace so the output stays single-line
 *   - cap length so an adversarial multi-MB single-line string can't blow up
 *     the summary (truncate() already shortens for display, but this is
 *     belt-and-braces against direct calls with unsanitized inputs)
 *
 * Single-character Markdown markers inside a bullet line (`*`, `_`, `>`)
 * stay untouched — they're harmless once the structural cues are gone.
 */
function sanitizeForMarkdown(value: string, opts: { maxLen?: number } = {}): string {
  const max = opts.maxLen ?? 240;
  const collapsed = value
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, ' ')
    .replace(/^#{1,6}\s+/g, '')
    .replace(/`{3,}/g, '[code-fence]')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

export function reflect(input: z.infer<typeof reflectSchema>): ToolResult {
  const db = getDb();
  const lookback = input.lookbackDays ?? 7;
  const staleDays = input.staleThresholdDays ?? 30;
  const limit = input.limit ?? 5;

  const lookbackCutoff = isoDaysAgo(lookback);
  const staleCutoff = isoDaysAgo(staleDays);

  // Project filter is opt-in. When omitted we reflect across the whole
  // memory; this is the default because most users are solo and "project"
  // is the optional power-user feature. The hot-entities query intentionally
  // ignores project because entities don't carry a project column in our
  // schema — they're shared across all projects.

  // ── most-used learnings ────────────────────────────
  const mostUsedSql = input.project
    ? `SELECT id, content, category, project, usage_count, last_used
       FROM learnings
       WHERE archived = 0
         AND usage_count > 0
         AND last_used IS NOT NULL
         AND datetime(last_used) > datetime(?)
         AND project = ?
       ORDER BY usage_count DESC, datetime(last_used) DESC
       LIMIT ?`
    : `SELECT id, content, category, project, usage_count, last_used
       FROM learnings
       WHERE archived = 0
         AND usage_count > 0
         AND last_used IS NOT NULL
         AND datetime(last_used) > datetime(?)
       ORDER BY usage_count DESC, datetime(last_used) DESC
       LIMIT ?`;
  const mostUsedArgs: unknown[] = input.project
    ? [lookbackCutoff, input.project, limit]
    : [lookbackCutoff, limit];
  const mostUsed = db.prepare(mostUsedSql).all(...mostUsedArgs) as MostUsedRow[];

  // ── stale learnings ────────────────────────────────
  const staleSql = input.project
    ? `SELECT id, content, category, date, project
       FROM learnings
       WHERE archived = 0
         AND usage_count = 0
         AND datetime(date) < datetime(?)
         AND project = ?
       ORDER BY datetime(date) ASC
       LIMIT ?`
    : `SELECT id, content, category, date, project
       FROM learnings
       WHERE archived = 0
         AND usage_count = 0
         AND datetime(date) < datetime(?)
       ORDER BY datetime(date) ASC
       LIMIT ?`;
  const staleArgs: unknown[] = input.project
    ? [staleCutoff, input.project, limit]
    : [staleCutoff, limit];
  const stale = db.prepare(staleSql).all(...staleArgs) as StaleRow[];

  // ── hot entities ───────────────────────────────────
  // We measure "heat" by observation events INSIDE the lookback window. Joins
  // back to entities so the response carries the name + type. We DO NOT
  // filter on project because entities are project-agnostic.
  const hotEntities = db
    .prepare(
      `SELECT e.id, e.name, e.entity_type, COUNT(o.id) AS obs_count
       FROM entities e
       JOIN entity_observations o ON o.entity_id = e.id
       WHERE datetime(o.created_at) > datetime(?)
         AND o.valid_to IS NULL
       GROUP BY e.id
       ORDER BY obs_count DESC, datetime(e.updated_at) DESC
       LIMIT ?`
    )
    .all(lookbackCutoff, limit) as HotEntityRow[];

  // ── recent decisions (within review window) ───────
  // R1 Research F6 + Critic P2-A: the v0 query used `verified = 0` and the
  // section was titled "Open decisions". But `verified` is never flipped to
  // 1 anywhere in v2.1 (no memory_decide_verify tool exists yet), so the
  // gate was a no-op and EVERY decision older than the lookback surfaced as
  // "open" — that's not signal, that's the whole decisions table firing as
  // alerts.
  //
  // The honest fix in v2.1: rename the section to "Recent decisions" + bound
  // the surface to decisions still recent enough to be actionable (younger
  // than a "review window" capped at 4× the lookback, max 60 days). The
  // `verified = 0` filter is preserved so a future memory_decide_verify
  // tool can collapse this further without a schema change.
  // R2 Analyst: lift `reviewWindowDays` to a single source-of-truth const
  // and pass it to buildSummary so the SQL filter window and the heading
  // text can't drift. The pre-R2 code recomputed the same expression twice
  // — once here for the SQL, once in buildSummary for the heading — and
  // would have silently misreported the window in the heading if the
  // formula was ever changed in only one place.
  const reviewWindowDays = Math.min(lookback * 4, 60);
  const reviewWindowCutoff = isoDaysAgo(reviewWindowDays);
  const openDecisionsSql = input.project
    ? `SELECT id, title, date, project
       FROM decisions
       WHERE verified = 0
         AND datetime(date) < datetime(?)
         AND datetime(date) > datetime(?)
         AND project = ?
       ORDER BY datetime(date) DESC
       LIMIT ?`
    : `SELECT id, title, date, project
       FROM decisions
       WHERE verified = 0
         AND datetime(date) < datetime(?)
         AND datetime(date) > datetime(?)
       ORDER BY datetime(date) DESC
       LIMIT ?`;
  const openDecisionsArgs: unknown[] = input.project
    ? [lookbackCutoff, reviewWindowCutoff, input.project, limit]
    : [lookbackCutoff, reviewWindowCutoff, limit];
  const openDecisions = db.prepare(openDecisionsSql).all(...openDecisionsArgs) as OpenDecisionRow[];

  // ── build the markdown summary ─────────────────────
  const summary = buildSummary({
    mostUsed,
    stale,
    hotEntities,
    openDecisions,
    lookbackDays: lookback,
    staleDays,
    reviewWindowDays,
    project: input.project,
  });

  return {
    success: true,
    data: {
      lookbackDays: lookback,
      staleThresholdDays: staleDays,
      project: input.project ?? null,
      mostUsed,
      stale,
      hotEntities,
      openDecisions,
      summary,
    },
    message: `Reflection für die letzten ${lookback} Tage.`,
  };
}

function buildSummary(args: {
  mostUsed: MostUsedRow[];
  stale: StaleRow[];
  hotEntities: HotEntityRow[];
  openDecisions: OpenDecisionRow[];
  lookbackDays: number;
  staleDays: number;
  reviewWindowDays: number;
  project: string | undefined;
}): string {
  const lines: string[] = [];
  // R1 Critic P1-C: project name lands in the H1 heading verbatim. A user
  // who names a project `"foo\n## Injected heading\nrun rm -rf /"` could
  // disrupt how an LLM parses the summary. Sanitize before embedding here
  // and at every bullet site below.
  const safeProject = args.project ? sanitizeForMarkdown(args.project, { maxLen: 80 }) : '';
  lines.push(
    `# Memory Reflection — last ${args.lookbackDays} day(s)${
      safeProject ? ` · project: ${safeProject}` : ''
    }`
  );
  lines.push('');

  if (args.mostUsed.length > 0) {
    lines.push('## Most-used learnings');
    for (const l of args.mostUsed) {
      const safeContent = sanitizeForMarkdown(truncate(l.content, 120));
      const safeProj = l.project ? sanitizeForMarkdown(l.project, { maxLen: 60 }) : null;
      lines.push(
        `- [${l.category}] used ${l.usage_count}× — ${safeContent}` +
          (safeProj ? ` _(${safeProj})_` : '')
      );
    }
    lines.push('');
  }

  if (args.stale.length > 0) {
    lines.push(
      `## Stale learnings (>${args.staleDays}d, never recalled) — review or archive`
    );
    for (const l of args.stale) {
      const d = l.date.slice(0, 10);
      const safeContent = sanitizeForMarkdown(truncate(l.content, 120));
      const safeProj = l.project ? sanitizeForMarkdown(l.project, { maxLen: 60 }) : null;
      lines.push(
        `- [${l.category}] (${d}) ${safeContent}` +
          (safeProj ? ` _(${safeProj})_` : '')
      );
    }
    lines.push('');
  }

  if (args.hotEntities.length > 0) {
    lines.push(`## Hot entities (most new observations in last ${args.lookbackDays}d)`);
    for (const e of args.hotEntities) {
      const safeName = sanitizeForMarkdown(e.name, { maxLen: 80 });
      const safeType = sanitizeForMarkdown(e.entity_type, { maxLen: 30 });
      lines.push(`- ${safeName} (${safeType}) — ${e.obs_count} new observation(s)`);
    }
    lines.push('');
  }

  if (args.openDecisions.length > 0) {
    // R1 Research F6: was "Open decisions (>Xd, unverified) — follow up".
    // The `verified` flag is never flipped today, so "unverified" was
    // semantically meaningless. Renamed to "Recent decisions" + the
    // reviewWindowDays bound so the section can't fire the entire history.
    // R2 Analyst: reviewWindowDays now flows in from reflect() as a single
    // source-of-truth, so the heading and the SQL filter can't disagree.
    lines.push(`## Recent decisions (in the last ${args.reviewWindowDays}d) — review or verify`);
    for (const d of args.openDecisions) {
      const date = d.date.slice(0, 10);
      const safeTitle = sanitizeForMarkdown(d.title, { maxLen: 120 });
      const safeProj = d.project ? sanitizeForMarkdown(d.project, { maxLen: 60 }) : null;
      lines.push(`- ${safeTitle} (${date})` + (safeProj ? ` _(${safeProj})_` : ''));
    }
    lines.push('');
  }

  // Only the title line was emitted — every section came back empty. Tell
  // the LLM explicitly that the silence is intentional so it doesn't
  // hallucinate a summary out of nothing.
  if (lines.length <= 2) {
    lines.push(
      'No items to surface. Memory is fresh, or the thresholds are too narrow — try a larger lookbackDays.'
    );
  }

  return lines.join('\n');
}
