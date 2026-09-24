/**
 * Two scope lists naming the same scopes are the same list.
 *
 * The rest of this file's original neighbours tested the context-compile subsystem,
 * which is gone. This one survived the deletion because what it pins survived: scope
 * identity is what the hash is for, and a reader that sorts differently would silently
 * be a different reader.
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeContextScopes } from '../../src/memory/types.js';

describe('scope identity', () => {
  it('canonicalizes scope order and produces a stable scope hash', () => {
    const left = canonicalizeContextScopes([
      { kind: 'user', id: 'u-1' },
      { kind: 'project', id: 'beta' },
      { kind: 'project', id: 'alpha' },
      { kind: 'project', id: 'alpha' },
    ]);
    const right = canonicalizeContextScopes([
      { kind: 'project', id: 'alpha' },
      { kind: 'user', id: 'u-1' },
      { kind: 'project', id: 'beta' },
    ]);

    expect(left.scopes).toEqual([
      { kind: 'project', id: 'alpha' },
      { kind: 'project', id: 'beta' },
      { kind: 'user', id: 'u-1' },
    ]);
    expect(left.scopeHash).toBe(right.scopeHash);
    expect(left.scopeJson).toBe(right.scopeJson);
  });
});
