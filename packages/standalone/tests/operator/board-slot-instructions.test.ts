import { describe, expect, it } from 'vitest';
import {
  boardHtmlClassVocabulary,
  buildBoardHtmlVocabulary,
} from '../../src/operator/board-slot-instructions.js';

describe('board card vocabulary', () => {
  it('requires a card time line the board styles', () => {
    expect(boardHtmlClassVocabulary().has('card-meta')).toBe(true);
    expect(buildBoardHtmlVocabulary().join('\n')).toMatch(/card-meta is required on every card/);
  });
});
