import { describe, it, expect } from 'vitest';
import { MEMORY_KINDS } from '../../src/memory/types.js';
import type { MemoryKind } from '../../src/memory/types.js';

describe('MEMORY_KINDS', () => {
  it('holds what a memory is, and nothing about one product', () => {
    // It used to carry `task`, `schedule` and `compiled`, added for a connector
    // extraction that never wrote them. Nothing in either package stores those kinds
    // and no row in the live database has one; they named an owner board, a cron and
    // a context packet, which are things one product has rather than things a memory
    // can be.
    expect([...MEMORY_KINDS]).toEqual(['decision', 'preference', 'constraint', 'lesson', 'fact']);
  });

  it('each one is a MemoryKind', () => {
    const kinds: MemoryKind[] = ['decision', 'preference', 'constraint', 'lesson', 'fact'];
    expect(kinds).toHaveLength(MEMORY_KINDS.length);
  });
});
