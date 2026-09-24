/**
 * The product's SQLite wrapper.
 *
 * This file used to re-export the core's copy. The driver moved down here because a
 * shared core that opens a particular database engine is not shared: it is that engine's
 * library with other things attached.
 */
export { default } from './storage-sqlite.js';
export type { SQLiteDatabase, SQLiteRunResult, SQLiteStatement } from './storage-sqlite.js';
