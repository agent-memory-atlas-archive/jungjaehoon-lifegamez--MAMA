import { homedir } from 'node:os';
import { join } from 'node:path';
import { declareEmbeddingCacheDir } from '@jungjaehoon/mama-core/embeddings';

// Tests embed with the real model; keep it out of node_modules like the plugin does (db-path.js).
declareEmbeddingCacheDir(join(homedir(), '.cache', 'huggingface', 'transformers'));
