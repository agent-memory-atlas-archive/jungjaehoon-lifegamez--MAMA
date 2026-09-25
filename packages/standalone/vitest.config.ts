import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // better-sqlite3 is a native module; replay tests open source and raw SQLite
    // handles in one run, so keep the worker process single and deterministic.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
