/**
 * Embedding pipeline — local, on-device, multilingual.
 *
 * Default model: Xenova/multilingual-e5-small (Apache-2.0, 384-dim).
 * Runs entirely on the host CPU via Transformers.js. The model is lazily
 * fetched the first time embed() is called (~120 MB cached into the
 * Hugging Face cache dir) and reused as a singleton afterwards.
 *
 * Failure mode contract: every helper in this module is allowed to return
 * null. Callers MUST treat null as "embedding unavailable" and continue with
 * the FTS5-only path. We never throw out of embed().
 *
 * Three operating modes:
 *
 *   1. Real model (default)
 *      Uses @huggingface/transformers feature-extraction pipeline with mean
 *      pooling + L2 normalization. Output is a 384-dim Float32Array suitable
 *      for sqlite-vec cosine search.
 *
 *   2. MEMORY_EMBED_MOCK=1
 *      Returns a deterministic, fully synchronous 384-dim vector derived from
 *      a bag-of-tokens hash. Two strings that share tokens produce vectors
 *      that score high on cosine similarity, two strings that share none
 *      score near zero. This is what tests use so we don't drag the model
 *      download into CI. Documented in CONTRIBUTING.md.
 *
 *   3. MEMORY_EMBED_DISABLED=1
 *      embed() always returns null. Callers fall through to FTS5-only paths.
 *      For restricted networks (corporate proxies, air-gapped machines).
 */
import { logger } from './logger.js';

export const EMBEDDING_DIM = 384;
export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small';

type FeatureExtractionPipeline = (
  text: string | string[],
  options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean }
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

interface EmbedderState {
  ready: boolean;
  pipeline: FeatureExtractionPipeline | null;
  warned: boolean;
  modelId: string;
  /** Tri-state: 'real' (model loaded / loading) | 'mock' | 'disabled'. */
  mode: 'real' | 'mock' | 'disabled';
}

const state: EmbedderState = {
  ready: false,
  pipeline: null,
  warned: false,
  modelId: process.env.MEMORY_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
  mode: process.env.MEMORY_EMBED_DISABLED === '1'
    ? 'disabled'
    : process.env.MEMORY_EMBED_MOCK === '1'
      ? 'mock'
      : 'real',
};

let initPromise: Promise<FeatureExtractionPipeline | null> | null = null;

/**
 * Lazy-load Transformers.js + the feature-extraction pipeline. Returns null
 * if the model can't be loaded (network blocked, OOM, etc.).
 *
 * Retry contract (F1 fix from R1 review): a failure clears `initPromise` so
 * the next embed() call can retry. Otherwise a single transient model-fetch
 * blip (HF Hub down, slow CI runner, dropped packet during the initial
 * download) would poison the singleton for the whole process lifetime,
 * silently dropping every subsequent insert's embedding. We still suppress
 * the log after the first warn via `state.warned` to avoid stderr spam.
 */
async function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (state.mode !== 'real') return null;
  if (state.pipeline) return state.pipeline;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Dynamic import: Transformers.js is heavy. We only pay the cost the
      // first time someone actually calls embed().
      const transformers = await import('@huggingface/transformers');
      const { pipeline, env } = transformers as {
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>
        ) => Promise<FeatureExtractionPipeline>;
        env: {
          cacheDir?: string;
          allowLocalModels?: boolean;
          allowRemoteModels?: boolean;
        };
      };

      // Custom cache dir if the user asked for one. Default leaves
      // Transformers.js' built-in OS-conventional location (under
      // ~/.cache/huggingface/transformers/ on Linux).
      if (process.env.MEMORY_EMBED_CACHE_DIR) {
        env.cacheDir = process.env.MEMORY_EMBED_CACHE_DIR;
      }

      const extractor = await pipeline('feature-extraction', state.modelId, {
        // q8 quantization keeps the model ~30 MB instead of ~120 MB while
        // preserving cosine similarity within a few hundredths of a unit on
        // standard retrieval benchmarks. Override with MEMORY_EMBED_DTYPE if
        // you need full precision.
        dtype: (process.env.MEMORY_EMBED_DTYPE as 'fp32' | 'fp16' | 'q8' | 'q4') ?? 'q8',
      });
      state.pipeline = extractor;
      state.ready = true;
      logger.info(`[embed] model loaded: ${state.modelId}`);
      return extractor;
    } catch (err) {
      // Most common reasons: no network in a corporate environment,
      // @huggingface/transformers not installed (lighter consumer like a CI
      // smoke build), or transient HF Hub failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (!state.warned) {
        logger.warn(`[embed] model load failed — falling back to FTS5-only: ${msg}`);
        state.warned = true;
      }
      state.pipeline = null;
      // Clear the cached promise so the next embed() call retries the load.
      // Without this we'd be permanently stuck returning null forever, even
      // after the underlying failure (network blip, HF Hub down) recovered.
      initPromise = null;
      return null;
    }
  })();

  return initPromise;
}

/**
 * Returns true once we know the real model is alive. Useful for callers that
 * want to gate auto-embed-on-insert without paying the lazy-load roundtrip.
 */
export function isEmbedReady(): boolean {
  return state.mode !== 'disabled' && (state.mode === 'mock' || state.ready);
}

/**
 * What mode are we in? Surfaced via memory_health for visibility.
 */
export function embedMode(): 'real' | 'mock' | 'disabled' {
  return state.mode;
}

export function embedModelId(): string {
  return state.modelId;
}

/**
 * Deterministic mock embedding: a bag-of-tokens hash into 384 buckets with L2
 * normalization. Two strings that share tokens land in overlapping buckets so
 * cosine similarity is meaningful for tests. The hash is FNV-1a so a single
 * extra token barely moves the vector.
 *
 * NOT cryptographic — collisions are fine here, we just need stability.
 */
export function mockEmbed(text: string): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  const tokens = text.toLowerCase().normalize('NFKD').match(/\p{L}+/gu) ?? [];
  for (const token of tokens) {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const idx = h % EMBEDDING_DIM;
    v[idx] += 1;
    // Spread into a second bucket so close-but-not-identical tokens land
    // partially overlapping, which keeps cosine well-behaved for short text.
    const idx2 = (h >>> 8) % EMBEDDING_DIM;
    v[idx2] += 0.5;
  }
  // L2 normalize so cosine = dot product, matching what sqlite-vec expects.
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i] * v[i];
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] *= inv;
  return v;
}

/**
 * Produce a 384-dim Float32Array embedding for `text`.
 *
 * Returns null if embeddings are disabled or the model failed to load. All
 * callers (auto-embed on insert, hybrid search) MUST handle null by falling
 * back to FTS5-only behaviour.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (state.mode === 'disabled') return null;
  if (state.mode === 'mock') return mockEmbed(text);

  const ex = await getPipeline();
  if (!ex) return null;

  try {
    // multilingual-e5 family expects "query: " / "passage: " prefixes for
    // optimal retrieval. We use "passage: " here because everything stored
    // is content, and prefix the search input with "query: " on the read
    // path. This matches the model card recommendation.
    const result = await ex(`passage: ${text}`, { pooling: 'mean', normalize: true });
    const data = result.data;
    // Result.data is typically Float32Array already; defensive copy.
    if (data instanceof Float32Array) {
      if (data.length === EMBEDDING_DIM) return data;
      // Some quantization paths return a wider tensor — slice if needed.
      return new Float32Array(data.subarray(0, EMBEDDING_DIM));
    }
    const arr = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM && i < data.length; i++) {
      arr[i] = (data as number[])[i] ?? 0;
    }
    return arr;
  } catch (err) {
    if (!state.warned) {
      logger.warn(`[embed] inference failed: ${err instanceof Error ? err.message : String(err)}`);
      state.warned = true;
    }
    return null;
  }
}

/**
 * Embed a query string. multilingual-e5 family uses the "query: " prefix on
 * the read side. Same null contract as embed().
 */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  if (state.mode === 'disabled') return null;
  if (state.mode === 'mock') return mockEmbed(text);

  const ex = await getPipeline();
  if (!ex) return null;
  try {
    const result = await ex(`query: ${text}`, { pooling: 'mean', normalize: true });
    const data = result.data;
    if (data instanceof Float32Array) {
      return data.length === EMBEDDING_DIM ? data : new Float32Array(data.subarray(0, EMBEDDING_DIM));
    }
    const arr = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM && i < data.length; i++) {
      arr[i] = (data as number[])[i] ?? 0;
    }
    return arr;
  } catch (err) {
    if (!state.warned) {
      logger.warn(`[embed] query inference failed: ${err instanceof Error ? err.message : String(err)}`);
      state.warned = true;
    }
    return null;
  }
}

/**
 * Reset the singleton — used by tests to swap modes between cases. Production
 * callers should never use this.
 */
export function _resetForTests(): void {
  state.ready = false;
  state.pipeline = null;
  state.warned = false;
  state.modelId = process.env.MEMORY_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  state.mode =
    process.env.MEMORY_EMBED_DISABLED === '1'
      ? 'disabled'
      : process.env.MEMORY_EMBED_MOCK === '1'
        ? 'mock'
        : 'real';
  initPromise = null;
}
