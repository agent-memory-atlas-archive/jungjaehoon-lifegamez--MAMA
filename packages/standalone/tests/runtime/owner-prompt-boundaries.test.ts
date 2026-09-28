import { describe, expect, it } from 'vitest';
import { ownerSystemPrompt } from '../../src/runtime/owner-system-prompt.js';

describe('owner delegation prompt', () => {
  it.each(['claude', 'codex'] as const)(
    'spawns subagents only when an order asks and promises no post-turn delivery for %s',
    (backend) => {
      const prompt = ownerSystemPrompt(backend, null, [], true, 'UTC');
      expect(prompt).not.toContain('run_in_background');
      expect(prompt).not.toContain('it is still delivered to the channel that asked');
      expect(prompt).not.toContain('Delegate when it helps');
      expect(prompt).toContain('only when an order asks for one');
    }
  );
});
