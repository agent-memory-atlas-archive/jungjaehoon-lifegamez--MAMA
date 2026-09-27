import { describe, expect, it } from 'vitest';
import { applyWikiEdits } from '../../src/wiki/wiki-edits.js';

describe('wiki section edits', () => {
  it('appends at the end of a section before the next heading of the same level', () => {
    const page = '## A\n- one\n\n### A.1\ndetail\n\n## B\n- two';
    expect(applyWikiEdits(page, [{ section: '## A', append: '- three' }])).toBe(
      '## A\n- one\n\n### A.1\ndetail\n- three\n\n## B\n- two'
    );
  });

  it('creates a missing section for an append and rejects a replace of a missing section', () => {
    expect(applyWikiEdits('## A\ntext\n', [{ section: '## New', append: 'first line' }])).toBe(
      '## A\ntext\n\n## New\nfirst line\n'
    );
    expect(() => applyWikiEdits('## A\ntext', [{ section: '## New', replace: 'x' }])).toThrow(
      /section not found/
    );
  });

  it('needs a heading and exactly one of append or replace', () => {
    expect(() => applyWikiEdits('x', [{ section: 'History', append: 'a' }])).toThrow(/heading/);
    expect(() => applyWikiEdits('## A', [{ section: '## A', append: 'a', replace: 'b' }])).toThrow(
      /exactly one/
    );
  });
});
