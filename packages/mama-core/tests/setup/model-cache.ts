import { homedir } from 'node:os';
import { join } from 'node:path';
import { declareEmbeddingCacheDir } from '../../src/embedding/embedder.js';

// A consumer states its model cache (embedder.ts); for tests that is the machine cache,
// so installs that recreate node_modules do not delete the model.
declareEmbeddingCacheDir(join(homedir(), '.cache', 'huggingface', 'transformers'));
