/**
 * This package's own test database helper.
 *
 * It used to come from `@jungjaehoon/mama-core/test-utils`, a published subpath whose
 * only purpose was testing. Publishing a test helper makes it part of the package's
 * public surface: anything that breaks in it is a breaking change for consumers who
 * never asked for it. The core keeps its copy for its own tests and publishes nothing.
 *
 * Four functions, which is all this package's three test files ever used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetDBState, initDB, closeDB } from '@jungjaehoon/mama-core/db-manager';

const created = new Set();

/**
 * Open an empty, migrated database under a temp path and make it the process-wide one.
 *
 * The path is set before initDB because the core reads it from the environment; a test
 * that skips this opens the real user database.
 */
export async function initTestDB(testName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mama-mcp-${testName}-`));
  const dbPath = path.join(dir, 'test.db');
  process.env.MAMA_DB_PATH = dbPath;
  resetDBState();
  await initDB();
  created.add(dir);
  return dbPath;
}

/** Close the handle and remove the temp directory. Safe to call twice. */
export async function cleanupTestDB(dbPath) {
  try {
    closeDB();
  } catch {
    // Already closed, or never opened. Either way there is nothing to release.
  }
  resetDBState();
  delete process.env.MAMA_DB_PATH;
  if (!dbPath) {
    return;
  }
  const dir = path.dirname(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
  created.delete(dir);
}

/**
 * Whether the embedding model can load here.
 *
 * Tests that need vectors skip rather than fail when it cannot: a machine without the
 * model downloaded is not a broken build, and reporting it as one trains people to
 * ignore red.
 */
export async function isEmbeddingsAvailable() {
  try {
    const { generateEmbedding } = await import('@jungjaehoon/mama-core/embeddings');
    const vector = await generateEmbedding('probe', 'query');
    return Array.isArray(vector) && vector.length > 0;
  } catch {
    return false;
  }
}

/** The smallest tool context the MCP tools read. */
export function createMockToolContext() {
  return {
    scopes: [],
    sessionId: 'test-session',
    requestId: 'test-request',
  };
}
