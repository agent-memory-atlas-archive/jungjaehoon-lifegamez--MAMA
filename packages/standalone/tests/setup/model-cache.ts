import { declareModelCache } from '../../src/runtime/model-cache.js';

// Tests embed with the real model; keep it out of node_modules (see runtime/model-cache.ts).
declareModelCache();
