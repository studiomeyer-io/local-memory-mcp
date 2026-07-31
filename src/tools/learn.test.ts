/**
 * Tests for the learning gatekeeper, recall, and FTS search behaviour.
 *
 * The DB client is pointed at a tmp sqlite file per test via MEMORY_DB_PATH.
 * Each test creates a fresh DB so cases don't leak state into each other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We must set MEMORY_DB_PATH BEFORE the modules that import the singleton db.
let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  // reset the singleton db so next test opens a fresh one
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('db bootstrap', () => {
  it('creates schema on first call and survives re-open', async () => {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('learnings');
    expect(names).toContain('decisions');
    expect(names).toContain('entities');
    expect(names).toContain('entity_observations');
    expect(names).toContain('entity_relations');
    expect(names).toContain('meta');
  });

  it('WAL mode is active', async () => {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('FTS5 virtual table exists and is queryable', async () => {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    // Querying a FTS5 table with an empty MATCH should not throw; FTS5
    // returns zero rows for missing tokens.
    expect(() => db.prepare("SELECT * FROM search_fts WHERE search_fts MATCH 'nonexistent' LIMIT 1").all()).not.toThrow();
  });
});

describe('learn gatekeeper', () => {
  it('inserts a brand new learning and returns added', async () => {
    const { learn } = await import('./learn.js');
    const result = await learn({
      category: 'pattern',
      content: 'FTS5 search is cheap in SQLite when triggers keep the index warm.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { action: string; id: string };
      expect(data.action).toBe('added');
      expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('returns skipped_duplicate for exact re-insert', async () => {
    const { learn } = await import('./learn.js');
    const first = await learn({ category: 'pattern', content: 'exactly the same sentence' });
    const second = await learn({ category: 'pattern', content: 'exactly the same sentence' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (second.success) {
      const data = second.data as { action: string };
      expect(data.action).toBe('skipped_duplicate');
    }
  });

  it('auto-classifies mistake category as episodic memory', async () => {
    const { learn } = await import('./learn.js');
    const result = await learn({
      category: 'mistake',
      content: 'I forgot to quote the fts query and it crashed on multi-word input.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { memoryType: string };
      expect(data.memoryType).toBe('episodic');
    }
  });

  it('auto-classifies architecture as semantic memory', async () => {
    const { learn } = await import('./learn.js');
    const result = await learn({
      category: 'architecture',
      content: 'The bundle ships a platform-specific native binding per OS.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { memoryType: string };
      expect(data.memoryType).toBe('semantic');
    }
  });

  it('Analyst R2 #5: updated_similar branch re-embeds atomically (UPDATE branch regression)', async () => {
    // The gatekeeper's UPDATE branch (when an FTS5-similar but shorter
    // learning exists) was the second code path that calls the F4 atomic
    // pattern. R1 added regression for the fresh-INSERT path; this test
    // closes the gap on the UPDATE path so a future change to learn.ts
    // can't quietly leave its atomicity unguarded.
    const { learn } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');

    // Seed a short version
    const first = await learn({
      category: 'pattern',
      content: 'sqlite vec hybrid',
    });
    expect(first.success).toBe(true);
    const firstId = first.success ? (first.data as { id: string }).id : '';

    // Add the long version which should trigger updated_similar
    const longer = await learn({
      category: 'pattern',
      content:
        'sqlite vec hybrid search uses bm25 fused with cosine via reciprocal rank fusion at k 60 which is the canonical setting documented by alex garcia',
    });
    expect(longer.success).toBe(true);
    if (longer.success) {
      const d = longer.data as { id: string; action: string };
      // Either updated_similar (gatekeeper triggered) or a fresh add — both
      // are valid depending on how aggressive FTS5 was on the short prefix.
      // What matters: if the same id is reused, its embedding must be
      // upserted; if a new id was added, both ids must have an embedding.
      const db = getDb();
      if (isVectorEnabled()) {
        if (d.action === 'updated_similar') {
          expect(d.id).toBe(firstId);
          const e = db
            .prepare('SELECT content_id FROM embeddings WHERE content_id = ?')
            .get(d.id) as { content_id: string } | undefined;
          expect(e).toBeDefined();
        } else {
          const eCount = (db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
          expect(eCount).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('never destroys an existing learning when storing a new one', async () => {
    // Silent data loss: storing an unrelated learning REPLACES an existing
    // one and reports action "updated_similar", which reads like success.
    //
    // Cause: the soft gatekeeper matches escapeFtsQuery(content.slice(0, 200))
    // against `search_fts`. That helper ORs every token by design (docstring
    // in src/db/client.ts), so ordinary words match almost any row; bm25() is
    // an unbounded length-scaled score, not a normalised similarity; so the
    // overwrite decision reduces to "the new entry is longer".
    //
    // The filler is not padding — bm25 is corpus-relative. With one stored
    // document every matched token has IDF near zero: score -0.000008, so
    // `score < -5` is unreachable. Measured here: 1 doc -0.000008, 6 docs
    // -4.80, 11 docs -8.16. A suite storing two rows per case never sees it.
    //
    // The assertion names no victim. Which row bm25 ranks first is incidental;
    // the contract is that storing one learning never removes or rewrites
    // another. Every insert is therefore part of the act, leaving nothing for
    // the defect to corrupt before the assertions run.
    //
    // By hand: restore the soft gatekeeper block in src/tools/learn.ts and
    // re-run — two entries vanish, and the row holding the last document
    // reports category "pattern" with empty tags.
    const { learn } = await import('./learn.js');
    const { getDb, escapeFtsQuery } = await import('../db/client.js');

    const filler = [
      'The build pipeline caches compiled artifacts between runs to avoid repeating work.',
      'Feature flags are evaluated once per request and memoised for the duration.',
      'Database migrations run forward only; rollbacks use a compensating migration.',
      'The retry policy uses exponential backoff with jitter capped at thirty seconds.',
      'Structured logs are emitted as newline delimited JSON for ingestion downstream.',
      'Session cookies are marked secure, httponly, and samesite lax by default.',
      'Static assets are fingerprinted so they can be cached indefinitely at the edge.',
      'Background jobs are idempotent because the queue guarantees at least once delivery.',
      'Connection pools are sized to the number of worker threads, not to peak traffic.',
      'Timestamps are stored in UTC and converted only at the presentation layer.',
      'The linter runs as a pre-commit hook and again in continuous integration.',
      'Secrets are injected as environment variables and never written to disk.',
      'Pagination uses an opaque cursor rather than an offset to stay stable under writes.',
      'Health checks distinguish liveness from readiness so restarts are not triggered early.',
      'Metrics are sampled at one percent for traces and one hundred percent for counters.',
    ];
    // Two longer notes on unrelated subjects, sharing no distinctive
    // vocabulary. The last is more than 50 characters longer than the one
    // before it, the shape the length heuristic reacts to.
    const documents = [
      ...filler.map((content) => ({ category: 'pattern' as const, tags: ['ops'], content })),
      {
        category: 'infrastructure' as const,
        tags: ['packaging'],
        content:
          'A package manager that defers install scripts will print a warning and skip every install and postinstall hook until an operator approves them explicitly. Libraries that ship prebuilt platform binaries inside their published archive keep working regardless.',
      },
      {
        category: 'architecture' as const,
        tags: ['parsing'],
        content:
          'A template compiler stamps the name of the producing rule onto every node that rule returns. When a rule hands back a flat array of nodes it did not produce, those borrowed nodes lose their own provenance and any consumer mapping positions back to rules is misled. Returning a single wrapper that spans the whole region preserves the inner names, and wrapper instances must never be reused across nested regions because each reuse overwrites the match state of its parent.',
      },
    ];

    // Record what each call REPORTED, not just what it did. The silence is
    // half the defect: every one of these returns success.
    const reportedAsMerged: string[] = [];
    const store = async (doc: (typeof documents)[number]) => {
      const result = await learn(doc);
      expect(result.success, `learn() failed outright for: ${doc.content.slice(0, 40)}...`).toBe(true);
      if (result.success && (result.data as { action: string }).action === 'updated_similar') {
        reportedAsMerged.push(`"${doc.content.slice(0, 40)}..." returned success with action "updated_similar"`);
      }
    };

    // All but the last, so the guard below inspects the corpus the final call
    // will actually see.
    for (const doc of documents.slice(0, -1)) {
      await store(doc);
    }

    const db = getDb();
    const last = documents[documents.length - 1]!;

    // Precondition guard. Edit the corpus above and the score can drift back
    // over the threshold, at which point the defect stops reproducing and this
    // test would go green while the bug is still present. Fail loudly instead.
    const candidate = db
      .prepare(
        `SELECT bm25(search_fts) AS score
         FROM search_fts
         JOIN learnings l ON l.id = search_fts.content_id
         WHERE search_fts MATCH ? AND search_fts.content_type = 'learning'
         AND l.archived = 0
         ORDER BY score
         LIMIT 1`
      )
      .get(escapeFtsQuery(last.content.slice(0, 200))) as { score: number } | undefined;
    expect(
      candidate?.score,
      'corpus no longer reaches the gatekeeper threshold, so this test can no longer detect the defect'
    ).toBeLessThan(-5);

    await store(last);

    const rows = db
      .prepare('SELECT content, category, tags_json FROM learnings WHERE archived = 0')
      .all() as Array<{ content: string; category: string; tags_json: string }>;

    // Entries that are simply gone.
    const destroyed = documents
      .filter((d) => !rows.some((r) => r.content === d.content))
      .map((d) => `"${d.content.slice(0, 40)}..." is gone`);

    // Rows that survived carrying someone else's metadata. The UPDATE rewrites
    // only `content`, so a row that absorbed another entry keeps the destroyed
    // one's category and tags, which is what hides the corruption from
    // tag-scoped search.
    const wrongMetadata = documents
      .map((doc) => {
        const row = rows.find((r) => r.content === doc.content);
        if (!row) return null; // already counted as destroyed
        const tags = JSON.parse(row.tags_json) as string[];
        const sameTags =
          tags.length === doc.tags.length && tags.every((tag, i) => tag === doc.tags[i]);
        if (row.category === doc.category && sameTags) return null;
        return `"${doc.content.slice(0, 40)}..." was written as ${doc.category}/${JSON.stringify(doc.tags)} but its row reads ${row.category}/${row.tags_json}`;
      })
      .filter((entry): entry is string => entry !== null);

    // One assertion carrying the whole defect, so a red run shows all three
    // faces of it at once: the destruction, the success reported while
    // destroying, and the metadata left describing content that no longer
    // exists. Asserting these separately would hide the later ones, because
    // the first failure ends the test.
    expect({ destroyed, reportedAsMerged, wrongMetadata }).toEqual({
      destroyed: [],
      reportedAsMerged: [],
      wrongMetadata: [],
    });
    expect(rows).toHaveLength(documents.length);
  });
});

// ─── P3.3 v2.1.0 — learn_archive ──────────────────────

describe('learn_archive', () => {
  it('archives a live learning and flips archived + lifecycle_state + archived_at', async () => {
    const { learn, learnArchive } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const created = await learn({ category: 'pattern', content: 'first archive target' });
    expect(created.success).toBe(true);
    const id = created.success ? (created.data as { id: string }).id : '';

    const archived = learnArchive({ learningId: id, reason: 'wrong' });
    expect(archived.success).toBe(true);
    if (archived.success) {
      const d = archived.data as { action: string; lifecycleState: string };
      expect(d.action).toBe('archived');
      expect(d.lifecycleState).toBe('archived:wrong');
    }

    const row = getDb()
      .prepare(
        'SELECT archived, archived_at, lifecycle_state FROM learnings WHERE id = ?'
      )
      .get(id) as { archived: number; archived_at: string; lifecycle_state: string };
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBeTruthy();
    expect(row.lifecycle_state).toBe('archived:wrong');
  });

  it('idempotent: a second archive call returns already_archived without mutating', async () => {
    const { learn, learnArchive } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const created = await learn({ category: 'pattern', content: 'idempotency target' });
    const id = created.success ? (created.data as { id: string }).id : '';

    const first = learnArchive({ learningId: id });
    expect(first.success).toBe(true);
    const archivedAt1 = (getDb().prepare('SELECT archived_at FROM learnings WHERE id = ?').get(id) as { archived_at: string }).archived_at;

    const second = learnArchive({ learningId: id, reason: 'should-not-stick' });
    expect(second.success).toBe(true);
    if (second.success) {
      expect((second.data as { action: string }).action).toBe('already_archived');
    }
    const archivedAt2 = (getDb().prepare('SELECT archived_at, lifecycle_state FROM learnings WHERE id = ?').get(id) as { archived_at: string; lifecycle_state: string });
    expect(archivedAt2.archived_at).toBe(archivedAt1);
    // The first call had no reason → lifecycle should stay plain 'archived'.
    expect(archivedAt2.lifecycle_state).toBe('archived');
  });

  it('archived learnings are filtered out of recall', async () => {
    const { learn, learnArchive, recall } = await import('./learn.js');
    const a = await learn({ category: 'pattern', content: 'visible after archive of sibling' });
    const b = await learn({ category: 'pattern', content: 'this one will be archived' });
    const bId = b.success ? (b.data as { id: string }).id : '';
    learnArchive({ learningId: bId });

    const r = recall({ query: 'archive' });
    expect(r.success).toBe(true);
    if (r.success) {
      const ids = (r.data as { results: Array<{ id: string }> }).results.map((x) => x.id);
      expect(ids).not.toContain(bId);
    }
    expect(a.success).toBe(true);
  });

  it('returns NOT_FOUND for an unknown id', async () => {
    const { learnArchive } = await import('./learn.js');
    const result = learnArchive({ learningId: 'no-such-id' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });
});

// ─── P3.3 v2.1.0 — learn_update ───────────────────────

describe('learn_update', () => {
  it('updates content, bumps usage_count, and re-embeds atomically', async () => {
    const { learn, learnUpdate } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    const created = await learn({ category: 'pattern', content: 'old content under test' });
    const id = created.success ? (created.data as { id: string }).id : '';

    const updated = await learnUpdate({ learningId: id, content: 'new content under test' });
    expect(updated.success).toBe(true);
    if (updated.success) {
      const d = updated.data as { action: string; contentChanged: boolean; reembedded: boolean };
      expect(d.action).toBe('updated');
      expect(d.contentChanged).toBe(true);
      if (isVectorEnabled()) {
        expect(d.reembedded).toBe(true);
      }
    }

    const row = getDb()
      .prepare('SELECT content, usage_count, last_used FROM learnings WHERE id = ?')
      .get(id) as { content: string; usage_count: number; last_used: string };
    expect(row.content).toBe('new content under test');
    expect(row.usage_count).toBeGreaterThanOrEqual(1);
    expect(row.last_used).toBeTruthy();

    if (isVectorEnabled()) {
      const e = getDb()
        .prepare('SELECT content_id FROM embeddings WHERE content_id = ?')
        .get(id) as { content_id: string } | undefined;
      expect(e).toBeDefined();
    }
  });

  it('updating only confidence does not re-embed', async () => {
    const { learn, learnUpdate } = await import('./learn.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    const created = await learn({ category: 'pattern', content: 'confidence-only update target' });
    const id = created.success ? (created.data as { id: string }).id : '';

    const updated = await learnUpdate({ learningId: id, confidence: 0.95 });
    expect(updated.success).toBe(true);
    if (updated.success) {
      const d = updated.data as { contentChanged: boolean; reembedded: boolean };
      expect(d.contentChanged).toBe(false);
      // reembedded must stay false even when vector is enabled.
      if (isVectorEnabled()) expect(d.reembedded).toBe(false);
    }
  });

  it('rejects updating an archived learning with code=ARCHIVED', async () => {
    const { learn, learnArchive, learnUpdate } = await import('./learn.js');
    const created = await learn({ category: 'pattern', content: 'archive-then-update target' });
    const id = created.success ? (created.data as { id: string }).id : '';
    learnArchive({ learningId: id });

    const update = await learnUpdate({ learningId: id, content: 'attempted edit' });
    expect(update.success).toBe(false);
    if (!update.success) {
      expect(update.code).toBe('ARCHIVED');
    }
  });

  it('rejects an update with NOTHING_TO_UPDATE when no field is provided', async () => {
    const { learn, learnUpdate } = await import('./learn.js');
    const created = await learn({ category: 'pattern', content: 'nothing-to-update test' });
    const id = created.success ? (created.data as { id: string }).id : '';
    const result = await learnUpdate({ learningId: id });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NOTHING_TO_UPDATE');
    }
  });

  it('returns NOT_FOUND for an unknown id', async () => {
    const { learnUpdate } = await import('./learn.js');
    const result = await learnUpdate({ learningId: 'no-such-id', content: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  it('updating tags persists as JSON, no re-embed required', async () => {
    const { learn, learnUpdate } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const created = await learn({ category: 'pattern', content: 'tag-update target' });
    const id = created.success ? (created.data as { id: string }).id : '';
    const updated = await learnUpdate({ learningId: id, tags: ['v2.1', 'phase3'] });
    expect(updated.success).toBe(true);

    const row = getDb()
      .prepare('SELECT tags_json FROM learnings WHERE id = ?')
      .get(id) as { tags_json: string };
    expect(JSON.parse(row.tags_json)).toEqual(['v2.1', 'phase3']);
  });
});

describe('recall + search', () => {
  it('recall without query returns both inserted learnings', async () => {
    const { learn, recall } = await import('./learn.js');
    await learn({ category: 'pattern', content: 'first pattern entry' });
    await learn({ category: 'insight', content: 'second insight entry' });
    const result = recall({});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ content: string }> };
      expect(data.results.length).toBeGreaterThanOrEqual(2);
      // Both entries should be present. We don't assert on order because
      // the schema stores timestamps at second resolution — two inserts in
      // the same second have an undefined relative order.
      const contents = data.results.map((r) => r.content);
      expect(contents).toContain('first pattern entry');
      expect(contents).toContain('second insight entry');
    }
  });

  it('recall with query uses FTS5 and finds the match', async () => {
    const { learn, recall } = await import('./learn.js');
    await learn({ category: 'pattern', content: 'the bluebird of happiness sings at dawn' });
    await learn({ category: 'pattern', content: 'completely unrelated thing about ducks' });
    const result = recall({ query: 'bluebird' });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ content: string }> };
      expect(data.results.length).toBe(1);
      expect(data.results[0]?.content).toContain('bluebird');
    }
  });

  it('unified search finds hits across learnings and decisions', async () => {
    const { learn } = await import('./learn.js');
    const { decide } = await import('./decide.js');
    const { search } = await import('./search.js');
    await learn({ category: 'pattern', content: 'pineapple pizza is controversial' });
    await decide({
      title: 'pineapple as topping',
      decision: 'yes to pineapple pizza',
      reasoning: 'enzymes balance the cheese fat',
    });
    const result = await search({ query: 'pineapple' });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ type: string }> };
      const types = data.results.map((r) => r.type);
      expect(types).toContain('learning');
      expect(types).toContain('decision');
    }
  });
});

describe('tool registry', () => {
  it('exports exactly 25 tools with valid JSON Schema for each', async () => {
    const { TOOLS, toMcpToolList } = await import('./registry.js');
    expect(TOOLS.length).toBe(25);
    const listed = toMcpToolList();
    expect(listed.length).toBe(25);
    for (const t of listed) {
      expect(t.name).toMatch(/^memory_/);
      expect(typeof t.description).toBe('string');
      expect((t.inputSchema as Record<string, unknown>).type).toBe('object');
    }
  });

  it('registers the four v2.2.0 portability + lifecycle tools', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const names = toMcpToolList().map((t) => t.name);
    expect(names).toContain('memory_observation_supersede');
    expect(names).toContain('memory_learn_bulk');
    expect(names).toContain('memory_export');
    expect(names).toContain('memory_import');
  });

  it('registers the four v2.1.0 lifecycle + reflection tools', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const names = toMcpToolList().map((t) => t.name);
    expect(names).toContain('memory_learn_archive');
    expect(names).toContain('memory_learn_update');
    expect(names).toContain('memory_contradictions');
    expect(names).toContain('memory_reflect');
  });

  it('registers the four previously-orphan tools (entity_create, entity_delete, goal, health)', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const names = toMcpToolList().map((t) => t.name);
    expect(names).toContain('memory_entity_create');
    expect(names).toContain('memory_entity_delete');
    expect(names).toContain('memory_goal');
    expect(names).toContain('memory_health');
  });

  it('memory_learn input schema includes required category and content', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const learn = toMcpToolList().find((t) => t.name === 'memory_learn');
    expect(learn).toBeDefined();
    const schema = learn!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain('category');
    expect(schema.required).toContain('content');
    expect(schema.properties.category).toBeDefined();
  });
});
