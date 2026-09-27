/**
 * Database Adapter Factory (SQLite-only)
 *
 * SQLite only. There is no PostgreSQL adapter here.
 *
 * @module db-adapter
 */

import { info } from '../debug-logger.js';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { NodeSQLiteAdapter } from './node-sqlite-adapter.js';
import type { VectorSearchResult, RunResult } from './base-adapter.js';
import type { DatabaseInstance } from '../db-manager.js';
import type { Statement } from './statement.js';

export { SQLiteAdapter, NodeSQLiteAdapter };
export type { Statement, VectorSearchResult, RunResult };

export interface AdapterConfig {
  dbPath?: string;
}

/**
 * Create SQLite database adapter
 *
 * @param config - Database configuration
 * @returns Configured SQLite adapter instance
 */
export function createAdapter(config: AdapterConfig = {}): DatabaseInstance {
  // SQLiteAdapter (extends NodeSQLiteAdapter) auto-detects: better-sqlite3 (preferred, FTS5) → node:sqlite (fallback)
  info('[db-adapter] Creating SQLite adapter (auto-detect driver)');
  const dbPath = config.dbPath || process.env.MAMA_DB_PATH;
  return new SQLiteAdapter({ dbPath });
}
