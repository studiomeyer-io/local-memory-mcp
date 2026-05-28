/**
 * Tests for the P3.4 memory_reflect aggregator.
 *
 * The tool is read-only and LLM-free, so the tests focus on:
 *   - correct lookback / stale window filtering
 *   - structured output payload shape
 *   - markdown summary contains the expected section headers
 *   - project filter scopes results without crossing scopes
 *
 * Each test uses a fresh tmp SQLite (per-test pattern from learn.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-reflect-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory_reflect', () => {
  it('returns a structured payload + a markdown summary in `data.summary`', async () => {
    const { reflect } = await import('./reflect.js');
    const result = reflect({});
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as {
        lookbackDays: number;
        staleThresholdDays: number;
        mostUsed: unknown[];
        stale: unknown[];
        hotEntities: unknown[];
        openDecisions: unknown[];
        summary: string;
      };
      expect(d.lookbackDays).toBe(7);
      expect(d.staleThresholdDays).toBe(30);
      expect(Array.isArray(d.mostUsed)).toBe(true);
      expect(Array.isArray(d.stale)).toBe(true);
      expect(Array.isArray(d.hotEntities)).toBe(true);
      expect(Array.isArray(d.openDecisions)).toBe(true);
      expect(d.summary).toContain('# Memory Reflection');
    }
  });

  it('surfaces a most-used learning that was touched inside the lookback window', async () => {
    const { learn } = await import('./learn.js');
    const { reflect } = await import('./reflect.js');
    const { getDb } = await import('../db/client.js');

    const a = await learn({ category: 'pattern', content: 'often-used pattern alpha' });
    expect(a.success).toBe(true);
    const aid = a.success ? (a.data as { id: string }).id : '';

    // Simulate usage: bump usage_count and pin last_used inside the lookback.
    getDb()
      .prepare('UPDATE learnings SET usage_count = 5, last_used = ? WHERE id = ?')
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '), aid);

    const result = reflect({ lookbackDays: 7 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as {
        mostUsed: Array<{ id: string; content: string; usage_count: number }>;
        summary: string;
      };
      const hit = d.mostUsed.find((l) => l.id === aid);
      expect(hit).toBeDefined();
      expect(hit?.usage_count).toBe(5);
      expect(d.summary).toContain('Most-used learnings');
      expect(d.summary).toContain('alpha');
    }
  });

  it('surfaces a stale learning that was never recalled and is older than threshold', async () => {
    const { learn } = await import('./learn.js');
    const { reflect } = await import('./reflect.js');
    const { getDb } = await import('../db/client.js');

    const created = await learn({ category: 'pattern', content: 'stale knowledge unused' });
    const id = created.success ? (created.data as { id: string }).id : '';
    // Rewind date to two months ago.
    getDb()
      .prepare("UPDATE learnings SET date = datetime('now', '-60 days'), usage_count = 0 WHERE id = ?")
      .run(id);

    const result = reflect({ staleThresholdDays: 30 });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { stale: Array<{ id: string }>; summary: string };
      const hit = d.stale.find((l) => l.id === id);
      expect(hit).toBeDefined();
      expect(d.summary).toContain('Stale learnings');
    }
  });

  it('surfaces a hot entity by counting recent observations', async () => {
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { reflect } = await import('./reflect.js');

    const e = entityCreate({ name: 'BusyEntity', entityType: 'project' });
    if (!e.success) throw new Error('setup failed');
    const eid = (e.data as { id: string }).id;
    for (let i = 0; i < 3; i++) {
      await entityObserve({ entityId: eid, content: `observation ${i}` });
    }

    const result = reflect({});
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as {
        hotEntities: Array<{ id: string; obs_count: number; name: string }>;
        summary: string;
      };
      const hit = d.hotEntities.find((x) => x.id === eid);
      expect(hit).toBeDefined();
      expect(hit?.obs_count).toBe(3);
      expect(d.summary).toContain('Hot entities');
      expect(d.summary).toContain('BusyEntity');
    }
  });

  it('surfaces an open decision older than the lookback window', async () => {
    const { decide } = await import('./decide.js');
    const { reflect } = await import('./reflect.js');
    const { getDb } = await import('../db/client.js');

    const d = await decide({
      title: 'whether to ship feature foo',
      decision: 'yes, ship it',
      reasoning: 'we evaluated and approved',
    });
    expect(d.success).toBe(true);
    const id = d.success ? (d.data as { id: string }).id : '';

    // Rewind the decision date so it falls outside the lookback (default 7d).
    getDb()
      .prepare("UPDATE decisions SET date = datetime('now', '-14 days') WHERE id = ?")
      .run(id);

    const result = reflect({ lookbackDays: 7 });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        openDecisions: Array<{ id: string; title: string }>;
        summary: string;
      };
      const hit = data.openDecisions.find((x) => x.id === id);
      expect(hit).toBeDefined();
      // R1 Research F6: section was renamed from "Open decisions" to
      // "Recent decisions" because the `verified = 0` gate is a no-op until
      // v2.2 adds a verify tool — the old heading mis-promised follow-up
      // semantics.
      expect(data.summary).toContain('Recent decisions');
    }
  });

  // ─── R1 Critic P1-C — Markdown / prompt-injection guard ────

  it('sanitizes Markdown-injection attempts in project, content, and decision titles', async () => {
    const { learn } = await import('./learn.js');
    const { decide } = await import('./decide.js');
    const { entityCreate, entityObserve } = await import('./entity.js');
    const { reflect } = await import('./reflect.js');
    const { getDb } = await import('../db/client.js');

    // Project name with a fake H2 + a triple-backtick fence + a newline
    // landing it in the H1 heading. After sanitisation the heading must
    // not gain an extra `## …` line and the fence must not open.
    const projectAttack = 'pX\n## INJECTED\n```bash\nrm -rf /\n```';
    const a = await learn({
      category: 'pattern',
      content: 'most-used content with\nembedded newline\n## fake heading',
      project: projectAttack,
    });
    expect(a.success).toBe(true);
    const aid = a.success ? (a.data as { id: string }).id : '';
    // Force into most-used bucket.
    getDb()
      .prepare('UPDATE learnings SET usage_count = 5, last_used = ? WHERE id = ?')
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '), aid);

    // Decision title with a fake heading prefix.
    const d = await decide({
      title: '## not really a heading',
      decision: 'irrelevant',
      reasoning: 'irrelevant',
    });
    const did = d.success ? (d.data as { id: string }).id : '';
    getDb()
      .prepare("UPDATE decisions SET date = datetime('now', '-14 days') WHERE id = ?")
      .run(did);

    // Entity name with embedded markdown.
    const e = entityCreate({ name: 'Entity\nWith\nNewlines', entityType: 'concept' });
    if (e.success) {
      const eid = (e.data as { id: string }).id;
      await entityObserve({ entityId: eid, content: 'recent observation' });
    }

    const result = reflect({ project: projectAttack });
    expect(result.success).toBe(true);
    if (result.success) {
      const summary = (result.data as { summary: string }).summary;
      // Heading must remain a SINGLE H1 — no injected H2 from project name.
      const h2Injected = summary.split('\n').filter((ln) => /^## INJECTED/.test(ln));
      expect(h2Injected.length).toBe(0);
      // Triple-backtick fences from user input must not open a code block
      // (sanitiser splices zero-width spaces between the backticks).
      expect(summary).not.toMatch(/^```bash$/m);
      expect(summary).not.toMatch(/^```$/m);
      // Heading-prefix on the decision title must be stripped.
      expect(summary).not.toContain('- ## not really a heading');
      // No bullet should span multiple lines (every newline in user input
      // gets collapsed to a space).
      const bulletLines = summary.split('\n').filter((ln) => ln.startsWith('- '));
      for (const ln of bulletLines) {
        expect(ln.includes('\n')).toBe(false);
      }
    }
  });

  it('scopes by project when provided and never mixes with other projects', async () => {
    const { learn } = await import('./learn.js');
    const { reflect } = await import('./reflect.js');
    const { getDb } = await import('../db/client.js');

    const a = await learn({ category: 'pattern', content: 'project-A entry', project: 'pA' });
    const b = await learn({ category: 'pattern', content: 'project-B entry', project: 'pB' });
    const aid = a.success ? (a.data as { id: string }).id : '';
    const bid = b.success ? (b.data as { id: string }).id : '';

    // Make both stale.
    getDb()
      .prepare("UPDATE learnings SET date = datetime('now', '-60 days'), usage_count = 0 WHERE id IN (?, ?)")
      .run(aid, bid);

    const scoped = reflect({ project: 'pA', staleThresholdDays: 30 });
    expect(scoped.success).toBe(true);
    if (scoped.success) {
      const d = scoped.data as { stale: Array<{ id: string; project: string }> };
      const ids = d.stale.map((x) => x.id);
      expect(ids).toContain(aid);
      expect(ids).not.toContain(bid);
    }
  });

  it('archived learnings never appear in stale or most-used', async () => {
    const { learn, learnArchive } = await import('./learn.js');
    const { reflect } = await import('./reflect.js');
    const { getDb } = await import('../db/client.js');

    const created = await learn({ category: 'pattern', content: 'archived-skip target' });
    const id = created.success ? (created.data as { id: string }).id : '';
    getDb()
      .prepare("UPDATE learnings SET date = datetime('now', '-60 days'), usage_count = 0 WHERE id = ?")
      .run(id);
    learnArchive({ learningId: id });

    const result = reflect({});
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as {
        stale: Array<{ id: string }>;
        mostUsed: Array<{ id: string }>;
      };
      expect(d.stale.find((x) => x.id === id)).toBeUndefined();
      expect(d.mostUsed.find((x) => x.id === id)).toBeUndefined();
    }
  });

  it('emits a friendly fallback line when every section is empty', async () => {
    const { reflect } = await import('./reflect.js');
    const result = reflect({});
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { summary: string };
      // Empty fixture → just the heading + the "nothing to surface" line.
      expect(d.summary).toContain('No items to surface');
    }
  });
});
