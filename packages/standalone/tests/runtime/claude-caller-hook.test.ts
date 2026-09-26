import { describe, expect, it } from 'vitest';
import { callerHookOutput } from '../../src/runtime/claude-caller-hook.js';

describe('Claude PreToolUse caller hook', () => {
  it.each([{}, { agent_id: 'child-1', agent_type: 'general-purpose' }])(
    'pins the Claude 2.1.x updatedInput shape for caller %j',
    (agent) => {
      const caller = { session_id: 'native-session', tool_use_id: 'call-1', ...agent };
      const input = { topic: 'fixture', nested: { limit: 3 }, __mama_caller: 'model value' };
      expect(
        callerHookOutput({
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__mama__work_create',
          tool_input: input,
          ...caller,
        })
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...input, __mama_caller: caller },
        },
      });
      expect(input.__mama_caller).toBe('model value');
    }
  );
});
