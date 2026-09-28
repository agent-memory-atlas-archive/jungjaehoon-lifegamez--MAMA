import { vi } from 'vitest';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeInvocationOptions } from '@jungjaehoon/mama-core/runtime/runtime';
import type { StimulusDelivery } from '../../src/runtime/stimulus-delivery.js';

/** Deliver one mailbox row and return the turn text the owner model receives. */
export async function deliveredPrompt(
  delivery: Pick<StimulusDelivery, 'deliver'>,
  row: MailboxRow,
  isNewSession: boolean,
  failAfterPreparation = false
): Promise<string> {
  let prompt = '';
  await delivery.deliver(row, {
    nativeInputId: row.stimulusId,
    resultForReceipt: () => null,
    run: async (
      content: Array<{ text?: string }>,
      request?: NativeInvocationOptions
    ): Promise<never> => {
      const prepared = await request?.prepareSessionContent?.({
        sessionId: 'owner-session',
        isNewSession,
      } as never);
      prompt = (prepared ?? content).map((block) => block.text ?? '').join('\n');
      if (failAfterPreparation) throw new Error('model turn did not complete');
      return {} as never;
    },
    steer: vi.fn(),
    wasDispatched: () => false,
    onInputDispatch: vi.fn(),
    onAccepted: vi.fn(),
  } as never);
  return prompt;
}
