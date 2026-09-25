import { describe, expect, it } from 'vitest';
import { ownerSystemPrompt } from '../../src/runtime/owner-system-prompt.js';

describe('owner standing prompt', () => {
  it('includes the Telegram formatter contract used by response delivery', () => {
    expect(ownerSystemPrompt('codex')).toContain('Telegram message formatting');
    expect(ownerSystemPrompt('codex')).toContain('Never write entity JSON');
  });

  it('tells the owner how to record source deltas and separates evidence from the ledger', () => {
    const prompt = ownerSystemPrompt('codex');
    expect(prompt).toContain(
      'For every source delta, decide whether it is nothing to record (acknowledgements or chatter) or a work item moved (requested, submitted, received, reviewed, feedback given, fixed, on hold, or delivered).'
    );
    expect(prompt).toContain(
      'When a work item moved, record it now in the work ledger: call work.list first, then work.revise for the existing item or work.create for a new item.'
    );
    expect(prompt).toContain(
      "Other systems' task rows or statuses (for example, task rows or cards) are evidence to cite, not the owner's work ledger."
    );
    expect(prompt).toContain(
      'If the owner should know about the delta, say so in the final answer.'
    );
  });
});
