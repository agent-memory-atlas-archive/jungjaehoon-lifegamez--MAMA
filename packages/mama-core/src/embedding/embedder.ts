/**
 * Embedding: the model, and one process-wide embedder over it.
 *
 * `createEmbedder` returns one embedder holding its own pipeline and cache. Two
 * calls give two independent embedders, so a caller can run a different model
 * without disturbing anyone else's, and a cache entry can never be served to a
 * caller that asked a different model for it.
 *
 * Below that, the module-level surface the rest of the product and the plugin
 * hooks call: `generateEmbedding`, the prefix scheme, the model facts and the
 * cosine. That surface lived in a top-level `embeddings.ts` that did nothing
 * but hold one embedder and re-expose it; a module that owns the model owns
 * the way to ask it for a vector. The published `@jungjaehoon/mama-core/embeddings`
 * subpath still points here, because it names a capability, not a file.
 *
 * @module embedding/embedder
 */

import { embeddingCache } from '../embedding-cache.js';
import { EmbeddingCache } from '../embedding-cache.js';
import { info } from '../debug-logger.js';
import { logComplete, logLoading } from '../progress-indicator.js';

export type EmbeddingPipeline = (
  text: string | string[],
  options?: { pooling?: string; normalize?: boolean; truncation?: boolean; max_length?: number }
) => Promise<{ data: Float32Array }>;

export interface EmbedderOptions {
  modelName: string;
  /** Vectors this model must produce. A mismatch is a failed load, not a warning. */
  dimension: number;
  quantized: boolean;
  maxLength: number;
  /**
   * Where the model files are cached. Optional: absent leaves it to the transformers
   * library's own convention, which is the caller's machine to decide, not this
   * library's.
   */
  cacheDir?: string;
  /**
   * Cache to use. Callers that share one embedder with existing consumers pass
   * the cache those consumers already clear and read stats from; omit it and the
   * embedder owns a private one.
   */
  cache?: EmbeddingCache;
}

export interface Embedder {
  readonly modelName: string;
  readonly dimension: number;
  /** Embed one already-prefixed input. The caller owns the role prefix. */
  embed(modelInput: string): Promise<Float32Array>;
  /** Load the model without embedding anything, so a caller can pay that cost up front. */
  warm(): Promise<void>;
  cache: EmbeddingCache;
}

/**
 * Build an embedder. The model loads on first use, not here.
 *
 * A failed load is remembered: the second call reports the original failure
 * instead of spending another model download on the same broken configuration.
 */
export function createEmbedder(options: EmbedderOptions): Embedder {
  const cache = options.cache ?? new EmbeddingCache();
  let pipeline: EmbeddingPipeline | null = null;
  let loadFailure: Error | null = null;

  async function load(): Promise<EmbeddingPipeline> {
    if (pipeline) {
      return pipeline;
    }
    if (loadFailure) {
      throw loadFailure;
    }

    logLoading(`Loading embedding model: ${options.modelName}...`);
    const startedAt = Date.now();

    try {
      // Dynamic import keeps the ES-module-only package out of the CommonJS graph.
      const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
      if (options.cacheDir) {
        env.cacheDir = options.cacheDir;
        info(`[embedder] Model cache directory: ${options.cacheDir}`);
      }

      pipeline = (await createPipeline('feature-extraction', options.modelName, {
        dtype: options.quantized ? 'q8' : 'fp32',
      })) as EmbeddingPipeline;

      logComplete(
        `Embedding model ready (${Date.now() - startedAt}ms, ${options.dimension}-dim, ${
          options.quantized ? 'q8' : 'fp32'
        })`
      );
      return pipeline;
    } catch (error) {
      loadFailure = error instanceof Error ? error : new Error(String(error));
      throw loadFailure;
    }
  }

  return {
    modelName: options.modelName,
    dimension: options.dimension,
    cache,

    async warm(): Promise<void> {
      await load();
    },

    async embed(modelInput: string): Promise<Float32Array> {
      const cached = cache.get(modelInput);
      if (cached) {
        return cached;
      }

      const model = await load();
      const output = await model(modelInput, {
        pooling: 'mean',
        normalize: true,
        truncation: true,
        max_length: options.maxLength,
      });

      const vector = output.data;
      if (vector.length !== options.dimension) {
        throw new Error(`Expected ${options.dimension}-dim, got ${vector.length}-dim`);
      }

      cache.set(modelInput, vector);
      return vector;
    },
  };
}

// Shared cache directory (not in node_modules)
/**
 * Which model, at what width, quantized or not.
 *
 * These used to be read from a config file under the product's home directory, which
 * meant the core could not produce an embedding until that product existed. They are
 * facts about the model, not about who is asking for one, so they live with the code
 * that loads it. A caller that wants a different model passes it.
 */
export const DEFAULT_MODEL_NAME = 'Xenova/multilingual-e5-large';

/**
 * Where the shared embedder caches its model files.
 *
 * The core used to compute one under the user's home directory and call it "the
 * library's convention". It is not: `@huggingface/transformers@3.8.1` caches under its
 * own package directory (`src/env.js:96`). So the old value was this library choosing
 * a location on one machine, for consumers that never asked - and dropping it outright
 * would move a 560MB model into `node_modules` and re-download it on the next run.
 *
 * A consumer states its own, once, before anything embeds. Nothing declared and no
 * `HF_HOME`/`TRANSFORMERS_CACHE` set leaves the library to its own default.
 */
let declaredCacheDir: string | undefined;

/** State where this consumer keeps its model cache. Call before the first embedding. */
export function declareEmbeddingCacheDir(dir: string): void {
  declaredCacheDir = dir;
}

/** Test seam: forget what was declared. */
export function clearEmbeddingCacheDir(): void {
  declaredCacheDir = undefined;
}
export const DEFAULT_EMBEDDING_DIM = 1024;
export const DEFAULT_QUANTIZED = true;

const TIER3_ENV_VALUES = new Set(['1', 'true', 'yes']);
export const EMBEDDING_MODEL_MAX_LENGTH = 512;
export const EMBEDDING_MAX_TOKENISH_SEGMENTS = 480;

// e5 instruction-prefix scheme. e5 models are trained with two prefixes: stored
// text is embedded as "passage: <text>", a search query as "query: <text>".
// Omitting them collapses cosine into a narrow cone. This constant is the single
// source of truth for the scheme identifier used by the runtime version guard.
export type EmbeddingRole = 'passage' | 'query';
export const EMBEDDING_PREFIX_SCHEME = 'e5-prefixed-v1';

function applyRolePrefix(preparedText: string, role: EmbeddingRole): string {
  return `${role}: ${preparedText}`;
}
const TOKENISH_SEGMENT_PATTERN =
  /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|\S+/gu;

// Type for pipeline function from @huggingface/transformers

// One process-wide embedder for callers that have not been given one of their
// own. `createEmbedder` owns the pipeline and its cache; this module only holds
// the instance and rebuilds it when the configured model changes.
let embedder: Embedder | null = null;

export function isForceTier3Enabled(): boolean {
  return TIER3_ENV_VALUES.has(String(process.env.MAMA_FORCE_TIER_3 || '').toLowerCase());
}

function assertEmbeddingsEnabled(): void {
  if (isForceTier3Enabled()) {
    throw new Error(
      'Embedding generation disabled because MAMA_FORCE_TIER_3=true. ' +
        'Tier 3 test mode must use lexical/no-vector fallback instead of loading the embedding model.'
    );
  }
}

export function prepareEmbeddingText(text: string): string {
  const trimmed = text.trim();
  let count = 0;
  let cutIndex = trimmed.length;

  for (const match of trimmed.matchAll(TOKENISH_SEGMENT_PATTERN)) {
    count++;
    if (count > EMBEDDING_MAX_TOKENISH_SEGMENTS) {
      cutIndex = match.index ?? trimmed.length;
      break;
    }
  }

  return cutIndex === trimmed.length ? trimmed : trimmed.slice(0, cutIndex).trimEnd();
}

/**
 * Decision object for enhanced embedding generation
 */
export interface DecisionForEmbedding {
  topic: string;
  decision: string;
  reasoning?: string;
  outcome?: string;
  confidence?: number;
  user_involvement?: string;
  evidence?: string | string[] | unknown;
  alternatives?: string | string[] | unknown;
  risks?: string;
}

/**
 * Load embedding model (configurable)
 *
 * Story M1.4 AC #2: Transformers.js singleton initialization
 * Story M1.4 AC #3: Changing model via config triggers informative log + resets caches
 *
 * @returns Embedding pipeline
 */
function resolveEmbedder(): Embedder {
  assertEmbeddingsEnabled();

  const modelName = DEFAULT_MODEL_NAME;

  // Story M1.4 AC #3: a configured model change resets the pipeline and cache.
  if (embedder && embedder.modelName !== modelName) {
    info('[MAMA] Embedding model changed - resetting pipeline');
    info(`[MAMA] Old model: ${embedder.modelName}`);
    info(`[MAMA] New model: ${modelName}`);
    embeddingCache.clear();
    embedder = null;
    info('[MAMA] Model cache cleared');
  }

  if (!embedder) {
    embedder = createEmbedder({
      modelName,
      dimension: DEFAULT_EMBEDDING_DIM,
      quantized: DEFAULT_QUANTIZED,
      maxLength: EMBEDDING_MODEL_MAX_LENGTH,
      // The environment a user set, else what this consumer declared, else the
      // library's own default. The core names no directory of its own.
      cacheDir: process.env.HF_HOME || process.env.TRANSFORMERS_CACHE || declaredCacheDir,
      // The shared cache: consumers already clear it and read its stats.
      cache: embeddingCache,
    });
  }

  return embedder;
}

/**
 * Generate embedding vector from text
 *
 * Story M1.4 AC #1: Uses configurable embeddingDim from config
 * Target: < 30ms latency
 *
 * @param text - Input text to embed
 * @returns Embedding vector (dimension from config)
 * @throws Error if text is empty or embedding fails
 */
export async function generateEmbedding(
  text: string,
  role: EmbeddingRole = 'passage'
): Promise<Float32Array> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  assertEmbeddingsEnabled();

  const preparedText = prepareEmbeddingText(text);
  const modelInput = applyRolePrefix(preparedText, role); // e5 instruction prefix

  // The embedder keys its cache on the PREFIXED input, so a passage vector can
  // never be served to a query.
  try {
    return await resolveEmbedder().embed(modelInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate embedding: ${message}`);
  }
}

/**
 * Generate enhanced embedding with content + metadata
 *
 * Task 3.4: Implement enhanced embedding format
 * Inspired by A-mem: Content + Metadata for richer semantic representation
 *
 * @param decision - Decision object
 * @returns 1024-dim enhanced embedding
 */
export async function generateEnhancedEmbedding(
  decision: DecisionForEmbedding,
  role: EmbeddingRole = 'passage'
): Promise<Float32Array> {
  // Construct enriched text representation with narrative fields (Story 2.2)
  const parts = [
    `Topic: ${decision.topic}`,
    `Decision: ${decision.decision}`,
    `Reasoning: ${decision.reasoning || 'N/A'}`,
    `Outcome: ${decision.outcome || 'ONGOING'}`,
    `Confidence: ${decision.confidence !== undefined ? decision.confidence : 0.5}`,
    `User Involvement: ${decision.user_involvement || 'N/A'}`,
  ];

  // Add narrative fields if present (Story 2.2: Narrative-Based Search)
  if (decision.evidence) {
    const evidenceText = Array.isArray(decision.evidence)
      ? decision.evidence.join('; ')
      : typeof decision.evidence === 'string'
        ? decision.evidence
        : JSON.stringify(decision.evidence);
    parts.push(`Evidence: ${evidenceText}`);
  }

  if (decision.alternatives) {
    const alternativesText = Array.isArray(decision.alternatives)
      ? decision.alternatives.join('; ')
      : typeof decision.alternatives === 'string'
        ? decision.alternatives
        : JSON.stringify(decision.alternatives);
    parts.push(`Alternatives: ${alternativesText}`);
  }

  if (decision.risks) {
    parts.push(`Risks: ${decision.risks}`);
  }

  const enrichedText = parts.join('\n').trim();

  return generateEmbedding(enrichedText, role);
}

/**
 * Calculate cosine similarity between two embeddings
 *
 * Utility for testing and validation
 *
 * @param embA - First embedding
 * @param embB - Second embedding
 * @returns Cosine similarity (0-1)
 */
export function cosineSimilarity(embA: Float32Array, embB: Float32Array): number {
  if (embA.length !== embB.length) {
    throw new Error('Embeddings must have same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < embA.length; i++) {
    dotProduct += embA[i] * embB[i];
    normA += embA[i] * embA[i];
    normB += embB[i] * embB[i];
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

  return similarity;
}

// Re-export embeddingCache for convenience
export { embeddingCache };

// Static snapshots of config values at module load time (Story M1.4)
export const EMBEDDING_DIM = DEFAULT_EMBEDDING_DIM;
export const MODEL_NAME = DEFAULT_MODEL_NAME;

// Expose config functions for external use
