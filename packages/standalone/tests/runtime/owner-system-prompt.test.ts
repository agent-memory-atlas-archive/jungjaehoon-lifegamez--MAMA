import { describe, expect, it } from 'vitest';
import { ownerSystemPrompt } from '../../src/runtime/owner-system-prompt.js';

describe('owner standing prompt', () => {
  it('includes the Telegram formatter contract used by response delivery', () => {
    expect(ownerSystemPrompt('codex')).toContain('Telegram message formatting');
    expect(ownerSystemPrompt('codex')).toContain('Never write entity JSON');
  });
});
