/**
 * Row shapes the SQLite drivers share.
 *
 * There used to be an abstract class here declaring the adapter's methods, which made
 * two definitions of the same port: this one and the DatabaseInstance interface in
 * db-manager. A driver now says which interface it satisfies rather than inheriting a
 * second copy of the contract.
 */

import type { Statement, RunResult } from './statement.js';

export type { Statement, RunResult };

export interface VectorSearchResult {
  rowid: number;
  similarity?: number;
  distance?: number;
}
