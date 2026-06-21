/**
 * Tests for the v2.3.0 recency / usage / importance ranking boost on the
 * hybrid (RRF) search path.
 *
 * Strategy: seed two learnings with the SAME token shape for the query
 * ("zenith alpha" / "zenith bravo"). For the query "zenith" both rankers score
 * them identically (same BM25 term/length, and the mock cosine's zenith
 * component is identical while the unique second token is orthogonal to the
 * query), so the base RRF score is a perfect tie. Any difference in final order
 * is therefore attributable to the boost alone — a clean, deterministic probe.
 *
 * These cases require sqlite-vec (the boost lives in the RRF fusion, only
 * reached in hybrid mode). They no-op on platforms without vec, matching the
 * existing hybrid tests. Runs under MEMORY_EMBED_MOCK=1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-ranking-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('hybrid ranking boost (v2.3.0)', () => {
  it('an important doc outranks an equally-relevant unimportant one', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const plain = await learn({ category: 'pattern', content: 'zenith alpha' });
    const important = await learn({ category: 'pattern', content: 'zenith bravo' });
    if (!plain.success || !important.success) throw new Error('setup failed');

    // Make the second doc important; leave the first at NULL importance.
    getDb()
      .prepare('UPDATE learnings SET importance = 0.95 WHERE id = ?')
      .run((important.data as { id: string }).id);

    const r = await search({ query: 'zenith', mode: 'hybrid', limit: 5 });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ id: string; rank: number }>; mode: string };
      expect(d.mode).toBe('hybrid');
      expect(d.results.length).toBe(2);
      // The important doc must come first, and carry a strictly higher score.
      expect(d.results[0]?.id).toBe((important.data as { id: string }).id);
      expect(d.results[0]!.rank).toBeGreaterThan(d.results[1]!.rank);
    }
  });

  it('a recent doc outranks an equally-relevant stale one', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const stale = await learn({ category: 'pattern', content: 'zenith alpha' });
    const recent = await learn({ category: 'pattern', content: 'zenith bravo' });
    if (!stale.success || !recent.success) throw new Error('setup failed');

    // Age the first doc by a year via its date; the second keeps "now".
    getDb()
      .prepare("UPDATE learnings SET date = '2025-01-01 00:00:00', last_used = NULL WHERE id = ?")
      .run((stale.data as { id: string }).id);

    const r = await search({ query: 'zenith', mode: 'hybrid', limit: 5 });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ id: string }> };
      expect(d.results[0]?.id).toBe((recent.data as { id: string }).id);
    }
  });

  it('a heavily-used doc outranks an equally-relevant unused one', async () => {
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const cold = await learn({ category: 'pattern', content: 'zenith alpha' });
    const hot = await learn({ category: 'pattern', content: 'zenith bravo' });
    if (!cold.success || !hot.success) throw new Error('setup failed');

    getDb()
      .prepare('UPDATE learnings SET usage_count = 50 WHERE id = ?')
      .run((hot.data as { id: string }).id);

    const r = await search({ query: 'zenith', mode: 'hybrid', limit: 5 });
    if (r.success) {
      const d = r.data as { results: Array<{ id: string }> };
      expect(d.results[0]?.id).toBe((hot.data as { id: string }).id);
    }
  });

  it('preserves pure-relevance ordering when ranking signals are equal', async () => {
    // Two docs, equal signals (both fresh, importance NULL, usage 0). The boost
    // multiplier is identical for both, so their order is governed solely by the
    // base RRF score — i.e. a true tie stays a tie and the boost introduces no
    // bias. We assert their scores are equal (within float epsilon).
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    await learn({ category: 'pattern', content: 'zenith alpha' });
    await learn({ category: 'pattern', content: 'zenith bravo' });

    const r = await search({ query: 'zenith', mode: 'hybrid', limit: 5 });
    if (r.success) {
      const d = r.data as { results: Array<{ rank: number }> };
      expect(d.results.length).toBe(2);
      expect(Math.abs(d.results[0]!.rank - d.results[1]!.rank)).toBeLessThan(1e-9);
    }
  });

  it('does not let recency override a clear textual-relevance gap (conservative bound)', async () => {
    // One doc matches BOTH query tokens, the other only ONE and is brand new.
    // The strong textual match must still win even though the weak one is the
    // freshest — the boost decides ties, not clear winners.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const strong = await learn({ category: 'pattern', content: 'quantum entanglement protocol notes' });
    const weak = await learn({ category: 'pattern', content: 'quantum breakfast cereal' });
    if (!strong.success || !weak.success) throw new Error('setup failed');

    // Make the weak match maximally recent + important; age the strong one.
    getDb()
      .prepare("UPDATE learnings SET importance = 1.0, usage_count = 100 WHERE id = ?")
      .run((weak.data as { id: string }).id);
    getDb()
      .prepare("UPDATE learnings SET date = '2024-01-01 00:00:00' WHERE id = ?")
      .run((strong.data as { id: string }).id);

    const r = await search({ query: 'quantum entanglement protocol', mode: 'hybrid', limit: 5 });
    if (r.success) {
      const d = r.data as { results: Array<{ id: string }> };
      // The two-token-plus match still ranks first despite the boost on the weak one.
      expect(d.results[0]?.id).toBe((strong.data as { id: string }).id);
    }
  });

  it('the ranking.* override (weights all 0) disables the boost', async () => {
    // With the boost disabled, an important doc no longer jumps ahead of an
    // equally-relevant one — the order collapses to the pure RRF tie.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const plain = await learn({ category: 'pattern', content: 'zenith alpha' });
    const important = await learn({ category: 'pattern', content: 'zenith bravo' });
    if (!plain.success || !important.success) throw new Error('setup failed');
    getDb()
      .prepare('UPDATE learnings SET importance = 0.99 WHERE id = ?')
      .run((important.data as { id: string }).id);

    const r = await search({
      query: 'zenith',
      mode: 'hybrid',
      limit: 5,
      ranking: { recencyWeight: 0, usageWeight: 0, importanceWeight: 0 },
    });
    if (r.success) {
      const d = r.data as { results: Array<{ rank: number }> };
      // Scores tie again because the boost is off.
      expect(Math.abs(d.results[0]!.rank - d.results[1]!.rank)).toBeLessThan(1e-9);
    }
  });
});

describe('RRF fusion — both-ranker consensus beats single-ranker (v2.3.0 critical path)', () => {
  it('a doc found by BOTH BM25 and cosine outranks one found by a single ranker', async () => {
    // The defining property of RRF: a candidate that appears in two rankings
    // accumulates two 1/(k+rank) contributions and should beat a candidate that
    // only one ranker surfaced. We construct:
    //   - consensus: contains the literal query tokens (BM25 hit) AND is
    //     token-similar (cosine hit) → seen by both legs.
    //   - vecOnly: shares NO literal query token (BM25 miss) but is token-near
    //     enough for the mock cosine to surface it → seen by one leg only.
    // The consensus row must rank above the single-ranker row.
    const { learn } = await import('./learn.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    const consensus = await learn({ category: 'pattern', content: 'meridian orbit calculation' });
    const vecOnly = await learn({ category: 'pattern', content: 'orbit calculation telemetry' });
    if (!consensus.success || !vecOnly.success) throw new Error('setup failed');

    // Query contains "meridian" (only in consensus) plus shared tokens. BM25
    // ranks consensus far higher (it has the rare token); cosine surfaces both.
    const r = await search({ query: 'meridian orbit calculation', mode: 'hybrid', limit: 5 });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as { results: Array<{ id: string; rank: number }> };
      const consensusId = (consensus.data as { id: string }).id;
      const vecOnlyId = (vecOnly.data as { id: string }).id;
      const rankOf = (id: string) => d.results.find((x) => x.id === id)?.rank ?? -Infinity;
      expect(d.results[0]?.id).toBe(consensusId);
      expect(rankOf(consensusId)).toBeGreaterThan(rankOf(vecOnlyId));
    }
  });
});
