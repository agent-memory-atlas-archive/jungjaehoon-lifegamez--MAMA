/**
 * Shared SQLite wrapper using better-sqlite3.
 * API-compatible with the previous node:sqlite wrapper.
 */

import BetterSqlite3 from 'better-sqlite3';

export interface SQLiteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SQLiteOpenOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export interface SQLiteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => SQLiteRunResult;
}

export type SQLiteDatabase = Database;

export default class Database {
  private db: BetterSqlite3.Database;
  readonly driver = 'better-sqlite3' as const;

  constructor(path: string, options?: SQLiteOpenOptions) {
    this.db = new BetterSqlite3(path, options);
  }

  prepare(sql: string): SQLiteStatement {
    const stmt = this.db.prepare(sql);
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => {
        const result = stmt.run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    return this.db.pragma(sql, options);
  }

  transaction<T extends (...args: never[]) => unknown>(
    fn: T,
    mode: 'deferred' | 'immediate' = 'deferred'
  ): T {
    const transaction = this.db.transaction(fn);
    return (mode === 'immediate' ? transaction.immediate : transaction) as unknown as T;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Test-only escape hatch to the underlying better-sqlite3 handle, for harnesses
   * that need connection-scoped features the wrapper does not surface (UDFs, TEMP
   * views). Never use this on a production path.
   */
  get unsafeRawHandle(): BetterSqlite3.Database {
    return this.db;
  }

  get open(): boolean {
    return this.db.open;
  }
}

/**
 * Present a better-sqlite3 handle as the core's database port.
 *
 * The two disagree on one method and it is the dangerous one: the port's `transaction`
 * RUNS the function and returns what it returned, while better-sqlite3's hands back a
 * runner you are expected to call. Passing a raw handle where the port is expected
 * therefore type-checks in loose positions and then commits nothing, which is how a
 * durable queue silently accepts writes and stores none.
 *
 * So the difference is stated once, here, and every caller goes through it.
 */
export function asDatabaseAdapter(db: {
  prepare: (sql: string) => unknown;
  exec: (sql: string) => unknown;
  transaction: (fn: (...args: never[]) => unknown) => (...args: never[]) => unknown;
}): {
  prepare: (sql: string) => never;
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => T;
} {
  return {
    prepare: (sql: string) => db.prepare(sql) as never,
    exec: (sql: string) => {
      db.exec(sql);
    },
    transaction: <T>(fn: () => T): T => (db.transaction(fn as never) as () => T)(),
  };
}
