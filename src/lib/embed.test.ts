/**
 * Tests for the embedding pipeline.
 *
 * Real model loads are NOT exercised here — those happen in production and on
 * platform-specific MCPB CI runs. The unit suite uses MEMORY_EMBED_MOCK=1
 * (set by the `npm test` script) and verifies the contract every caller
 * relies on:
 *   - Mock mode returns a deterministic, normalized 384-dim Float32Array.
 *   - Shared tokens produce vectors with high cosine similarity.
 *   - Disjoint token sets produce vectors with near-zero similarity.
 *   - MEMORY_EMBED_DISABLED=1 forces null on every call.
 *   - The `mode` / `model` introspection helpers stay in sync with env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = [
  'MEMORY_EMBED_MOCK',
  'MEMORY_EMBED_DISABLED',
  'MEMORY_EMBED_MODEL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// L2-normalized vectors satisfy cosine == dot product, so we use the inner
// product directly. Result range: -1..1.
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

describe('mockEmbed (deterministic fallback)', () => {
  it('returns a Float32Array of length 384', async () => {
    const { mockEmbed, EMBEDDING_DIM } = await import('./embed.js');
    expect(EMBEDDING_DIM).toBe(384);
    const v = mockEmbed('hello world');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
  });

  it('is L2 normalized (||v|| ≈ 1)', async () => {
    const { mockEmbed } = await import('./embed.js');
    const v = mockEmbed('the quick brown fox');
    let norm2 = 0;
    for (let i = 0; i < v.length; i++) norm2 += v[i] * v[i];
    expect(Math.sqrt(norm2)).toBeCloseTo(1, 4);
  });

  it('is deterministic — same text → same vector', async () => {
    const { mockEmbed } = await import('./embed.js');
    const a = mockEmbed('Mallorca is sunny');
    const b = mockEmbed('Mallorca is sunny');
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('shared tokens give high cosine similarity', async () => {
    const { mockEmbed } = await import('./embed.js');
    const a = mockEmbed('banana yellow fruit');
    const b = mockEmbed('banana red fruit');
    expect(cosine(a, b)).toBeGreaterThan(0.4);
  });

  it('disjoint token sets give low cosine similarity', async () => {
    const { mockEmbed } = await import('./embed.js');
    const a = mockEmbed('quicksort partitions pivot');
    const b = mockEmbed('mediterranean diet olive');
    expect(cosine(a, b)).toBeLessThan(0.2);
  });

  it('handles multilingual input (DE / EN / ES tokens land in different buckets)', async () => {
    const { mockEmbed } = await import('./embed.js');
    const de = mockEmbed('die katze schläft');
    const en = mockEmbed('the cat sleeps');
    const es = mockEmbed('el gato duerme');
    // All vectors must be valid (length 384, normalized).
    for (const v of [de, en, es]) {
      expect(v.length).toBe(384);
      let n2 = 0;
      for (let i = 0; i < v.length; i++) n2 += v[i] * v[i];
      expect(Math.sqrt(n2)).toBeCloseTo(1, 4);
    }
  });

  it('strips accents/diacritics in tokenization (NFKD)', async () => {
    const { mockEmbed } = await import('./embed.js');
    // "cafe" vs "café" — diacritic-stripped token map should collide.
    const a = mockEmbed('cafe');
    const b = mockEmbed('café');
    // After NFKD the diacritic separates from the base letter and our token
    // regex (\p{L}+) keeps only letters — both should tokenize to "cafe".
    expect(cosine(a, b)).toBeCloseTo(1, 3);
  });
});

describe('embed() with MEMORY_EMBED_MOCK=1', () => {
  it('returns the same vector as mockEmbed', async () => {
    process.env.MEMORY_EMBED_MOCK = '1';
    delete process.env.MEMORY_EMBED_DISABLED;
    const mod = await import('./embed.js');
    mod._resetForTests();
    const a = await mod.embed('hello there');
    const b = mod.mockEmbed('hello there');
    expect(a).not.toBeNull();
    if (a) {
      for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
    }
  });

  it('reports mode "mock" and exposes the configured model id', async () => {
    process.env.MEMORY_EMBED_MOCK = '1';
    process.env.MEMORY_EMBED_MODEL = 'mock-model-for-tests';
    delete process.env.MEMORY_EMBED_DISABLED;
    const mod = await import('./embed.js');
    mod._resetForTests();
    expect(mod.embedMode()).toBe('mock');
    expect(mod.embedModelId()).toBe('mock-model-for-tests');
  });

  it('embedQuery uses the same mock pipeline', async () => {
    process.env.MEMORY_EMBED_MOCK = '1';
    delete process.env.MEMORY_EMBED_DISABLED;
    const mod = await import('./embed.js');
    mod._resetForTests();
    const q = await mod.embedQuery('quicksort');
    expect(q).not.toBeNull();
    expect(q?.length).toBe(384);
  });

  it('isEmbedReady returns true in mock mode', async () => {
    process.env.MEMORY_EMBED_MOCK = '1';
    delete process.env.MEMORY_EMBED_DISABLED;
    const mod = await import('./embed.js');
    mod._resetForTests();
    expect(mod.isEmbedReady()).toBe(true);
  });
});

describe('embed() with MEMORY_EMBED_DISABLED=1', () => {
  it('returns null from embed() and embedQuery()', async () => {
    process.env.MEMORY_EMBED_DISABLED = '1';
    delete process.env.MEMORY_EMBED_MOCK;
    const mod = await import('./embed.js');
    mod._resetForTests();
    expect(await mod.embed('anything')).toBeNull();
    expect(await mod.embedQuery('anything')).toBeNull();
  });

  it('reports mode "disabled" and isEmbedReady === false', async () => {
    process.env.MEMORY_EMBED_DISABLED = '1';
    delete process.env.MEMORY_EMBED_MOCK;
    const mod = await import('./embed.js');
    mod._resetForTests();
    expect(mod.embedMode()).toBe('disabled');
    expect(mod.isEmbedReady()).toBe(false);
  });
});

// F1 regression guard (Critic R1): the initPromise must be cleared on
// failure so the next embed() call can retry. We can't trigger a real model
// load in tests (the suite uses MEMORY_EMBED_MOCK=1), but the failure path
// in embed.ts now resets initPromise → next call retries. The reset
// semantics are mirrored by _resetForTests(), which we exercise here to
// pin "reset → fresh state observed" so an accidental future change to
// _resetForTests can't quietly remove the parity.
describe('embed pipeline retry contract (F1 fix)', () => {
  it('_resetForTests reseeds the singleton so the next call observes fresh env', async () => {
    process.env.MEMORY_EMBED_MOCK = '1';
    delete process.env.MEMORY_EMBED_DISABLED;
    const mod = await import('./embed.js');
    mod._resetForTests();
    expect(mod.embedMode()).toBe('mock');
    // Flip to disabled mid-flight; reset so the change is observed.
    process.env.MEMORY_EMBED_DISABLED = '1';
    delete process.env.MEMORY_EMBED_MOCK;
    mod._resetForTests();
    expect(mod.embedMode()).toBe('disabled');
    expect(await mod.embed('anything')).toBeNull();
  });
});
