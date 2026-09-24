import { describe, expect, it } from 'vitest';
import { searchAllRaw } from '../../src/connectors/framework/raw-query.js';

describe('raw query input validation', () => {
  it('rejects an unknown scope kind before querying', () => {
    expect(() =>
      searchAllRaw({ prepare: () => ({ all: () => [], get: () => undefined }) } as never, {
        query: 'term',
        scopes: [{ kind: 'unknown-kind' as never, id: 'scope-test' }],
      })
    ).toThrow(/Invalid raw search scope kind/);
  });
});
