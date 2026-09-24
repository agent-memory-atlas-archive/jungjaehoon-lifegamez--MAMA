import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

describe('TelegramMessageLedger', () => {
  it('persists completion and suppresses a repeated delivery after reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-ledger-'));
    try {
      const path = join(root, 'ledger.json');
      const first = new TelegramMessageLedger(path);
      const binding = {
        deliveryTarget: 'telegram:7',
        payloadIdentity: createHash('sha256').update('answer').digest('hex'),
      };
      expect(first.claim('telegram:7:11', binding).claimed).toBe(true);
      first.markReady('telegram:7:11', 'answer', 'html-v1');
      first.markDelivered('telegram:7:11');

      const reopened = new TelegramMessageLedger(path);
      expect(reopened.claim('telegram:7:11', binding)).toMatchObject({
        claimed: false,
        entry: { state: 'delivered' },
      });
      expect(reopened.listUndelivered()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a changed payload for the same delivery identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-ledger-'));
    try {
      const ledger = new TelegramMessageLedger(join(root, 'ledger.json'));
      ledger.claim('outbound:answer', {
        deliveryTarget: 'telegram:7',
        payloadIdentity: createHash('sha256').update('first').digest('hex'),
      });
      expect(() =>
        ledger.claim('outbound:answer', {
          deliveryTarget: 'telegram:7',
          payloadIdentity: createHash('sha256').update('second').digest('hex'),
        })
      ).toThrow(/binding mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
