import { readFileSync } from 'node:fs';
import type { NativeToolCaller } from '@jungjaehoon/mama-core/action-contracts';

export const CLAUDE_CALLER_FIELD = '__mama_caller';

/** Claude 2.1.x PreToolUse: updatedInput replaces the entire input object. */
export function callerHookOutput(
  input: NativeToolCaller & { tool_input: unknown; [key: string]: unknown }
) {
  const { session_id, tool_use_id, agent_id, agent_type } = input;
  if (
    !session_id ||
    !tool_use_id ||
    !input.tool_input ||
    typeof input.tool_input !== 'object' ||
    Array.isArray(input.tool_input)
  ) {
    throw new Error('Claude caller hook requires session_id, tool_use_id and object tool_input');
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        ...input.tool_input,
        [CLAUDE_CALLER_FIELD]: {
          session_id,
          tool_use_id,
          ...(agent_id === undefined ? {} : { agent_id }),
          ...(agent_type === undefined ? {} : { agent_type }),
        },
      },
    },
  };
}

if (require.main === module) {
  try {
    process.stdout.write(
      `${JSON.stringify(callerHookOutput(JSON.parse(readFileSync(0, 'utf8'))))}\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
