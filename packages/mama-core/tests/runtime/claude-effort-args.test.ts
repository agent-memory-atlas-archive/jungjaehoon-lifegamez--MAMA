import { describe, expect, it } from 'vitest';
import { claudeEffortArgs } from '../../src/runtime/drivers/claude-effort.js';

describe('Claude --effort', () => {
  it.each([
    ['claude-opus-4-8', 'max', 'max'],
    ['claude-opus-4-7', 'xhigh', 'xhigh'],
    ['claude-sonnet-5', 'max', 'max'],
    ['claude-opus-5', 'xhigh', 'xhigh'],
    ['claude-opus-5-5', 'medium', 'medium'],
    ['claude-fable-5-1', 'xhigh', 'xhigh'],
    ['claude-sonnet-4-6', 'xhigh', 'high'],
    ['claude-opus-4-6', 'max', 'max'],
  ] as const)('passes the level %s accepts (%s → %s)', (model, effort, expected) => {
    expect(claudeEffortArgs(model, effort)).toEqual(['--effort', expected]);
  });

  it('passes no effort to a model without effort support or without a level', () => {
    expect(claudeEffortArgs('claude-haiku-4-5', 'high')).toEqual([]);
    expect(claudeEffortArgs(undefined, 'high')).toEqual([]);
    expect(claudeEffortArgs('claude-opus-5', undefined)).toEqual([]);
  });
});
