/** Startup carry uses durable inputs/results, gated by the transport's delivered receipts. */
import type { Mailbox, MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';

export interface OwnerExchange {
  owner: string;
  answer: string;
}

export function readRecentOwnerExchanges(
  mailbox: Mailbox,
  deliveredRefs: readonly string[],
  current: MailboxRow
): OwnerExchange[] {
  return deliveredRefs
    .slice(0, 20)
    .map((ref) => mailbox.readInput(ref, current.principalId))
    .filter(
      (row): row is MailboxRow =>
        row !== null && row.kind === 'owner_message' && row.stimulusId !== current.stimulusId
    )
    .sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id)
    .flatMap((row) => {
      const receipt = row.nativeDelivery?.receipt;
      if (!receipt) return [];
      const result = mailbox.nativeInputs.resultForReceipt(receipt, current.principalId);
      const payload = row.payload;
      if (
        !result ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof payload.text !== 'string'
      )
        return [];
      return [{ owner: payload.text, answer: result.response }];
    })
    .slice(0, 5)
    .reverse();
}
