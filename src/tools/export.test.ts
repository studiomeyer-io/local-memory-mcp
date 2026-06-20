/**
 * Tests for memory_export + memory_import (v2.2.0). The roundtrip case seeds
 * one DB, exports, switches MEMORY_DB_PATH to a fresh file, and imports —
 * proving the envelope is a faithful, portable backup. Embedding re-derivation
 * is exercised but only asserted when sqlite-vec loaded (isVectorEnabled).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-export-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'a.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(): Promise<{ entityId: string }> {
  const { learn } = await import('./learn.js');
  const { decide } = await import('./decide.js');
  const { entityCreate, entityObserve, entityRelate } = await import('./entity.js');
  const { profile, goal } = await import('./insights.js');

  await learn({ category: 'pattern', content: 'export uses a versioned envelope' });
  await decide({ title: 'Use RRF', decision: 'fuse BM25 + vector', reasoning: 'best recall' });

  const e1 = entityCreate({ name: 'Matthias', entityType: 'person' });
  const e2 = entityCreate({ name: 'StudioMeyer', entityType: 'company' });
  const eid1 = (e1.data as { id: string }).id;
  const eid2 = (e2.data as { id: string }).id;
  await entityObserve({ entityId: eid1, content: 'builds local-first memory tooling' });
  entityRelate({ fromEntityId: eid1, toEntityId: eid2, relationType: 'founder_of' });

  profile({ action: 'set', field: 'name', value: 'Matthias' });
  goal({ action: 'set', goal: 'ship v2.2.0' });

  return { entityId: eid1 };
}

describe('memory_export', () => {
  it('exports an empty DB as a well-formed envelope with zero counts', async () => {
    const { memoryExport } = await import('./export.js');
    const r = memoryExport({});
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as {
        format: string;
        version: number;
        counts: Record<string, number>;
        learnings: unknown[];
      };
      expect(d.format).toBe('studiomeyer-memory-export');
      expect(d.version).toBe(1);
      expect(d.counts.learnings).toBe(0);
      expect(d.learnings).toEqual([]);
    }
  });

  it('captures learnings, decisions, graph, profile and goal', async () => {
    const { memoryExport } = await import('./export.js');
    await seed();
    const r = memoryExport({});
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as {
        counts: Record<string, number>;
        profile: Record<string, string>;
        goal: string | null;
        relations: unknown[];
      };
      expect(d.counts.learnings).toBe(1);
      expect(d.counts.decisions).toBe(1);
      expect(d.counts.entities).toBe(2);
      expect(d.counts.observations).toBe(1);
      expect(d.counts.relations).toBe(1);
      expect(d.profile.name).toBe('Matthias');
      expect(d.goal).toBe('ship v2.2.0');
    }
  });

  it('honours includeSessions: false', async () => {
    const { memoryExport } = await import('./export.js');
    const { sessionStart } = await import('./session.js');
    await sessionStart({});
    const r = memoryExport({ includeSessions: false });
    if (r.success) {
      const d = r.data as { counts: Record<string, number>; sessions: unknown[] };
      expect(d.counts.sessions).toBe(0);
      expect(d.sessions).toEqual([]);
    }
  });
});

describe('memory_import', () => {
  it('roundtrips a full memory into a fresh database', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const { closeDb } = await import('../db/client.js');
    const { recall } = await import('./learn.js');
    const { entityOpen } = await import('./entity.js');

    await seed();
    const exp = memoryExport({});
    if (!exp.success) throw new Error('export failed');
    const envelope = exp.data;

    // Switch to a brand-new DB file and import there.
    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'b.sqlite');

    const imp = await memoryImport({ data: envelope as Record<string, unknown> });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number> };
      expect(d.imported.learnings).toBe(1);
      expect(d.imported.decisions).toBe(1);
      expect(d.imported.entities).toBe(2);
      expect(d.imported.observations).toBe(1);
      expect(d.imported.relations).toBe(1);
    }

    // Verify the data is actually queryable in the new DB.
    const rec = recall({ query: 'envelope' });
    if (rec.success) expect((rec.data as { count: number }).count).toBeGreaterThanOrEqual(1);

    const ent = entityOpen({ name: 'Matthias', entityType: 'person' });
    expect(ent.success).toBe(true);
    if (ent.success) {
      const d = ent.data as { observations: unknown[]; relations: unknown[] };
      expect(d.observations.length).toBe(1);
      expect(d.relations.length).toBe(1);
    }
  });

  it('is idempotent — re-importing the same envelope adds nothing', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    await seed();
    const exp = memoryExport({});
    if (!exp.success) throw new Error('export failed');

    // Import back into the SAME (already-populated) DB → everything is a dup.
    const imp = await memoryImport({ data: exp.data as Record<string, unknown> });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number> };
      expect(d.imported.learnings).toBe(0);
      expect(d.imported.entities).toBe(0);
      expect(d.imported.observations).toBe(0);
      expect(d.imported.relations).toBe(0);
    }
  });

  it('skips an observation whose entity is absent (dangling reference)', async () => {
    const { memoryImport } = await import('./export.js');
    const envelope = {
      format: 'studiomeyer-memory-export',
      version: 1,
      entities: [],
      observations: [{ id: 'o1', entityId: 'ghost-entity', content: 'orphan fact' }],
      relations: [],
      learnings: [],
      decisions: [],
      sessions: [],
    };
    const imp = await memoryImport({ data: envelope });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as {
        imported: Record<string, number>;
        skipped: Record<string, number>;
      };
      expect(d.imported.observations).toBe(0);
      expect(d.skipped.observationsMissingEntity).toBe(1);
    }
  });

  it('skips a relation whose endpoint is absent', async () => {
    const { memoryImport } = await import('./export.js');
    const envelope = {
      format: 'studiomeyer-memory-export',
      version: 1,
      entities: [{ id: 'e1', name: 'Solo', entityType: 'person' }],
      observations: [],
      relations: [{ id: 'r1', fromEntityId: 'e1', toEntityId: 'missing', relationType: 'knows' }],
      learnings: [],
      decisions: [],
      sessions: [],
    };
    const imp = await memoryImport({ data: envelope });
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.entities).toBe(1);
      expect(d.imported.relations).toBe(0);
      expect(d.skipped.relationsMissingEndpoint).toBe(1);
    }
  });

  it('rejects an unrecognised format', async () => {
    const { memoryImport } = await import('./export.js');
    const r = await memoryImport({ data: { format: 'mem0-export', version: 1 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('BAD_FORMAT');
  });

  it('rejects a future export version', async () => {
    const { memoryImport } = await import('./export.js');
    const r = await memoryImport({ data: { format: 'studiomeyer-memory-export', version: 999 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects version 0, negative, non-integer, and NaN (C2)', async () => {
    const { memoryImport } = await import('./export.js');
    for (const v of [0, -1, 1.5, NaN]) {
      const r = await memoryImport({ data: { format: 'studiomeyer-memory-export', version: v } });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('UNSUPPORTED_VERSION');
    }
  });

  it('skips a decision missing its NOT-NULL reasoning instead of inserting "" (C1)', async () => {
    const { memoryImport } = await import('./export.js');
    const envelope = {
      format: 'studiomeyer-memory-export',
      version: 1,
      entities: [],
      observations: [],
      relations: [],
      sessions: [],
      learnings: [],
      decisions: [{ id: 'd1', title: 'No reasoning', decision: 'do X' }], // reasoning omitted
    };
    const imp = await memoryImport({ data: envelope });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.decisions).toBe(0);
      expect(d.skipped.malformed).toBeGreaterThanOrEqual(1);
    }
  });

  it('re-derives embeddings on import when vec is enabled', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const { closeDb, getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    await seed();
    const exp = memoryExport({});
    if (!exp.success) throw new Error('export failed');

    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'c.sqlite');
    await memoryImport({ data: exp.data as Record<string, unknown> });

    // 1 learning + 1 decision + 1 observation = 3 embeddable rows.
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    expect(count).toBe(3);
  });
});
