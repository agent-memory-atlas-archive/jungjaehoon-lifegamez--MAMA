import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';
import { closeDB, resetDBState } from '@jungjaehoon/mama-core/db-manager';
import { declareEmbeddingCacheDir } from '@jungjaehoon/mama-core/embeddings';

// Tests embed with the real model; keep it out of node_modules like the plugin does (db-path.js).
declareEmbeddingCacheDir(join(homedir(), '.cache', 'huggingface', 'transformers'));

// Set isolation before any test module is imported, including validation tests
// whose error paths can initialize the database implicitly.
const originalEnv = { ...process.env };
const testHome = mkdtempSync(join(tmpdir(), 'mama-mcp-home-'));
await closeDB();
resetDBState();
process.env.HOME = testHome;
process.env.MAMA_DB_PATH = join(testHome, 'test.db');
delete process.env.MAMA_DATABASE_PATH;
// This package's contract includes vector search, so its tests run the real embedder even when a
// caller (the pre-commit hook) disables embeddings for the other packages.
delete process.env.MAMA_FORCE_TIER_3;
process.env.MAMA_TEST_MODEL_CACHE = join(originalEnv.HOME, '.cache', 'huggingface', 'transformers');

afterAll(async () => {
  await closeDB();
  resetDBState();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
  rmSync(testHome, { recursive: true, force: true });
});
