import { describe, expect, it } from 'vitest';
import { ownerSystemPrompt } from '../../src/runtime/owner-system-prompt.js';

describe('owner delegation prompt', () => {
  it.each(['claude', 'codex'] as const)(
    'does not promise unsupported post-turn delivery for %s',
    (backend) => {
      const prompt = ownerSystemPrompt(backend, null, [], true, 'UTC');
      expect(prompt).not.toContain('run_in_background');
      expect(prompt).not.toContain('it is still delivered to the channel that asked');
      expect(prompt).toContain('verify and integrate its result');
    }
  );
});
