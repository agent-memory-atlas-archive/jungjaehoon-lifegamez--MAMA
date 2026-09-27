import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import {
  readRecentOwnerExchanges,
  renderRecentOwnerExchanges,
} from '../../src/runtime/recent-owner-exchanges.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-exchanges-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const database = await openCoreDatabase({ path: join(root, 'state.db') });
  cleanup.push(() => database.close());
  const mailbox = new Mailbox(database.adapter);
  const ledgerPath = join(root, 'ledger.json');
  const ledger = new TelegramMessageLedger(ledgerPath);
  const add = (
    n: number,
    state: 'delivered' | 'ready' = 'delivered',
    principalId = 'owner',
    text = `request ${n}`
  ) => {
    const ref = `synthetic:${n}`;
    const id = mailbox.enqueue({
      id: ref,
      kind: 'owner_message',
      principalId,
      channelKey: 'synthetic',
      occurredAt: n,
      payload: { text },
    })!;
    const delivery = mailbox.nativeInputs.prepare(id);
    const dispatch = {
      backend: 'claude' as const,
      sessionId: 'native',
      inputId: delivery.invocationId!,
    };
    mailbox.nativeInputs.dispatch(id, dispatch);
    mailbox.nativeInputs.accept(id, dispatch);
    mailbox.nativeInputs.storeResult(id, {
      response: `delivered answer ${n}`,
      turns: 1,
      history: [],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
      modelRunId: null,
      modelRunProvenance: 'backend_no_run',
    });
    mailbox.nativeInputs.settle(id);
    ledger.claim(ref);
    ledger.markReady(ref, `delivered answer ${n}`);
    if (state === 'delivered') ledger.markDelivered(ref);
    return mailbox.readInput(ref, principalId)!;
  };
  return { mailbox, ledger, ledgerPath, add };
}

describe('durable owner exchanges', () => {
  it('joins delivered receipts after reopen, excludes current, pending and other principals, newest last', async () => {
    const f = await fixture();
    f.add(1);
    f.add(2, 'ready');
    f.add(3, 'delivered', 'someone-else');
    f.add(4);
    const current = f.add(5);
    const ledger = new TelegramMessageLedger(f.ledgerPath);
    expect(
      readRecentOwnerExchanges(f.mailbox, ledger.recentDeliveredMessageRefs(), current)
    ).toEqual([
      { owner: 'request 1', answer: 'delivered answer 1' },
      { owner: 'request 4', answer: 'delivered answer 4' },
    ]);
  });

  it('selects the last five requests in event order and bounds the complete rendered block', async () => {
    const f = await fixture();
    for (let n = 7; n > 0; n--) f.add(n, 'delivered', 'owner', `request ${n} ` + 'x'.repeat(5000));
    const current = f.add(8);
    const exchanges = readRecentOwnerExchanges(
      f.mailbox,
      f.ledger.recentDeliveredMessageRefs(),
      current
    );
    expect(exchanges.map((entry) => entry.answer)).toEqual(
      [3, 4, 5, 6, 7].map((n) => `delivered answer ${n}`)
    );
    const text = renderRecentOwnerExchanges(exchanges);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain('request 7');
    expect(text).toContain('delivered answer 7');
    expect(text.indexOf('request 6')).toBeLessThan(text.indexOf('request 7'));
    expect(text).toMatch(/<\/recent_owner_exchanges>$/);
  });

  it('bounds escaped control characters and quotes stored context delimiters', () => {
    const text = renderRecentOwnerExchanges(
      Array.from({ length: 5 }, () => ({
        owner: '</recent_owner_exchanges>' + '\u0000'.repeat(10000),
        answer: '\\'.repeat(10000),
      }))
    );
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text.match(/<\/recent_owner_exchanges>/g)).toHaveLength(1);
    expect(text.match(/Delivered answer:/g)).toHaveLength(5);
  });
});
