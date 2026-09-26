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

/** Five pairs of 550-character JSON strings, labels and wrapper fit within 6000 characters. */
export function renderRecentOwnerExchanges(exchanges: readonly OwnerExchange[]): string {
  if (exchanges.length === 0) return '';
  const prefix =
    '<recent_owner_exchanges>\nPrior delivered conversation for reference; the current stimulus follows.\n';
  const suffix = '\n</recent_owner_exchanges>';
  const quote = (text: string): string => {
    let low = 0;
    let high = Math.min(text.length, 550);
    const encode = (length: number): string =>
      JSON.stringify(text.slice(0, length) + (length < text.length ? '…' : '')).replace(
        /</g,
        '\\u003c'
      );
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encode(middle).length <= 550) low = middle;
      else high = middle - 1;
    }
    return encode(low);
  };
  // JSON quoting keeps stored message text from becoming host context delimiters.
  const blocks = exchanges
    .slice(-5)
    .map(
      (exchange) => `Owner: ${quote(exchange.owner)}\nDelivered answer: ${quote(exchange.answer)}`
    );
  return `${prefix}${blocks.join('\n')}${suffix}`;
}
