import { homedir } from 'node:os';
import { join } from 'node:path';
import { declareEmbeddingCacheDir } from '@jungjaehoon/mama-core/embeddings';

/**
 * Where MAMA keeps the embedding model (the archive product declared the same place,
 * cli/runtime/mama-core-init.ts:79). transformers.js otherwise caches inside its own
 * package directory under node_modules, and every `pnpm install` deleted the 560MB model.
 */
export function modelCacheDir(home: string = homedir()): string {
  return join(home, '.cache', 'huggingface', 'transformers');
}

/** Declare the model cache before anything embeds. */
export function declareModelCache(home?: string): string {
  const dir = modelCacheDir(home);
  declareEmbeddingCacheDir(dir);
  return dir;
}
