import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    fs: {
      strict: false,
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup/model-cache.js'],
    // Load the workspace core through Node like production does (see standalone vitest.config.ts).
    server: { deps: { external: [/packages\/mama-core\/dist\//] } },
    testTimeout: 30000,
    // Fix ONNX Runtime V8 locking issues with Transformers.js
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Isolate tests to prevent cross-contamination
    isolate: true,
    // Allow dynamic imports
    unstubGlobals: true,
  },
});
