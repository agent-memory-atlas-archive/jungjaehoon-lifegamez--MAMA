import { describe, expect, it } from 'vitest';

import { classifyQuestionType } from '../../src/knowledge/question-type.js';

describe('Phase 3 Task 10: question type classifier', () => {
  it.each([
    ['수정해 주세요', 'correction'],
    ['문서를 찾아줘', 'artifact'],
    ['이력을 보여줘', 'timeline'],
    ['상태는 어떤가요', 'status'],
    ['이유가 뭔가요', 'decision_reason'],
    ['설정을 알려줘', 'how_to'],
    ['전체 상태는 어떤가요', 'status'],
    ['회의 후에는 무슨 일이 있었나요', 'timeline'],
  ])('classifies Korean with attached particles: %s', (query, expected) => {
    expect(classifyQuestionType(query)).toBe(expected);
  });

  it('classifies correction questions', () => {
    expect(classifyQuestionType('fix the stale case status')).toBe('correction');
  });

  it('classifies artifact questions', () => {
    expect(classifyQuestionType('find the Obsidian doc for this case')).toBe('artifact');
  });

  it('classifies timeline questions', () => {
    expect(classifyQuestionType('when did this happen before 2026-04-18')).toBe('timeline');
  });

  it('classifies status questions', () => {
    expect(classifyQuestionType('what is the current progress now')).toBe('status');
  });

  it('classifies decision-reason questions', () => {
    expect(classifyQuestionType('why did we choose this because the reason matters')).toBe(
      'decision_reason'
    );
  });

  it('classifies how-to questions', () => {
    expect(classifyQuestionType('how to configure the ranker')).toBe('how_to');
  });

  it('falls back to unknown', () => {
    expect(classifyQuestionType('banana window silver')).toBe('unknown');
  });

  it('prioritizes correction over how-to', () => {
    expect(classifyQuestionType('how to fix the wrong case merge')).toBe('correction');
  });
});
