/**
 * Tests for memory_learn_bulk (v2.2.0). Embeddings run in MEMORY_EMBED_MOCK=1
 * mode (set by the npm test script); the vec-specific assertion is guarded on
 * isVectorEnabled().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-bulk-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory_learn_bulk', () => {
  it('inserts many learnings in one call and they are recallable', async () => {
    const { learnBulk, recall } = await import('./learn.js');
    const items = [
      { category: 'pattern' as const, content: 'use RRF k=60 for hybrid fusion' },
      { category: 'tool' as const, content: 'sqlite-vec gives local KNN' },
      { category: 'insight' as const, content: 'multilingual-e5-small covers DE EN ES' },
    ];
    const r = await learnBulk({ items });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { total: number; added: number; skipped: number; results: unknown[] };
      expect(d.total).toBe(3);
      expect(d.added).toBe(3);
      expect(d.skipped).toBe(0);
      expect(d.results.length).toBe(3);
    }

    const found = recall({ query: 'RRF' });
    expect(found.success).toBe(true);
    if (found.success) {
      expect((found.data as { count: number }).count).toBeGreaterThanOrEqual(1);
    }
  });

  it('skips exact duplicates inside the same batch (bumps usage, no double insert)', async () => {
    const { learnBulk, recall } = await import('./learn.js');
    const dup = 'the cache layer is redis';
    const r = await learnBulk({
      items: [
        { category: 'architecture' as const, content: dup },
        { category: 'architecture' as const, content: dup },
        { category: 'architecture' as const, content: 'unrelated fact about postgres' },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { added: number; skipped: number };
      expect(d.added).toBe(2);
      expect(d.skipped).toBe(1);
    }
    // Only one row for the duplicated content.
    const found = recall({ query: 'cache layer redis' });
    if (found.success) {
      const rows = (found.data as { results: Array<{ content: string }> }).results.filter(
        (x) => x.content === dup
      );
      expect(rows.length).toBe(1);
    }
  });

  it('skips content that already exists from a prior single learn()', async () => {
    const { learn, learnBulk } = await import('./learn.js');
    await learn({ category: 'security', content: 'rotate API keys every 90 days' });
    const r = await learnBulk({
      items: [
        { category: 'security' as const, content: 'rotate API keys every 90 days' },
        { category: 'security' as const, content: 'enable MFA everywhere' },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { added: number; skipped: number };
      expect(d.added).toBe(1);
      expect(d.skipped).toBe(1);
    }
  });

  it('writes embeddings for inserted rows when vec is enabled', async () => {
    const { learnBulk } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const before = (getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    await learnBulk({
      items: [
        { category: 'pattern' as const, content: 'embed on insert keeps recall warm' },
        { category: 'pattern' as const, content: 'atomic transaction wraps row plus vector' },
      ],
    });
    const after = (getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    expect(after - before).toBe(2);
  });

  it('rejects an empty batch and an over-large batch at the schema layer', async () => {
    const { learnBulkSchema } = await import('./learn.js');
    expect(learnBulkSchema.safeParse({ items: [] }).success).toBe(false);
    const tooMany = { items: Array.from({ length: 501 }, () => ({ category: 'pattern', content: 'x' })) };
    expect(learnBulkSchema.safeParse(tooMany).success).toBe(false);
    const ok = { items: [{ category: 'pattern', content: 'x' }] };
    expect(learnBulkSchema.safeParse(ok).success).toBe(true);
  });
});

describe('embedBatch', () => {
  it('returns one 384-dim vector per text and matches single embed (mock mode)', async () => {
    const { embedBatch, embed, embedMode, EMBEDDING_DIM } = await import('../lib/embed.js');
    const out = await embedBatch(['alpha beta gamma', 'delta epsilon']);
    expect(out.length).toBe(2);
    expect(out[0]).not.toBeNull();
    expect(out[0]!.length).toBe(EMBEDDING_DIM);
    // Bit-equality between batch and single only holds for the deterministic
    // mock embedder (the npm test script sets MEMORY_EMBED_MOCK=1). The real
    // model's batched matmul differs at ~1e-6, which is cosine-irrelevant, so
    // we only assert strict equality in mock mode to avoid a confusing red if
    // this file is ever run standalone against the real model.
    if (embedMode() === 'mock') {
      const single = await embed('alpha beta gamma');
      expect(Array.from(out[0]!)).toEqual(Array.from(single!));
    }
  });

  it('handles multilingual input and an empty batch', async () => {
    const { embedBatch, EMBEDDING_DIM } = await import('../lib/embed.js');
    expect(await embedBatch([])).toEqual([]);
    const out = await embedBatch(['café münchen', 'マルチリンガル', 'normal']);
    expect(out.length).toBe(3);
    for (const v of out) {
      expect(v).not.toBeNull();
      expect(v!.length).toBe(EMBEDDING_DIM);
    }
  });
});
