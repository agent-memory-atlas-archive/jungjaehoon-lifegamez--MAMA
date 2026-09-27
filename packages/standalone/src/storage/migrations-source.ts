/**
 * Where this package's own schema lives.
 *
 * The connector event index is declared here rather than by the core, because
 * three of the core's four consumers have no connectors and were creating
 * eighteen tables they never write. A migration belongs to whoever wrote it, and
 * its identity is (source, version), so this package's numbering is its own.
 */
import { dirname, join, resolve } from 'node:path';

/** Resolved from this file so it holds under both src and dist layouts. */
function packageRoot(): string {
  // src/storage/... or dist/storage/...
  return resolve(dirname(__filename), '..', '..');
}

export const STANDALONE_MIGRATION_SOURCE = {
  name: 'standalone',
  get dir(): string {
    return join(packageRoot(), 'db', 'migrations');
  },
} as const;
