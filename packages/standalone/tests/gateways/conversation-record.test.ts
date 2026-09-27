import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { openConversationRecord } from '../../src/gateways/conversation-record.js';
import { SessionStore } from '../../src/gateways/session-store.js';

describe('conversation record', () => {
  it('recovers the committed owner response without another model call', () => {
    const store = new SessionStore(new Database(':memory:'));
    const session = store.getOrCreate('telegram', '7', '9');
    const message = {
      source: 'telegram' as const,
      channelId: '7',
      userId: '9',
      text: 'question',
      metadata: { messageId: '11', chatType: 'private' },
      principal: {
        class: 'owner' as const,
        lane: 'owner' as const,
        canonicalId: 'telegram:global:9',
        consoleEligible: true as const,
      },
    };
    const input = () =>
      openConversationRecord({
        sessionStore: store,
        sessionId: session.id,
        message,
        sourceTurnId: '11',
        sourceMessageRef: 'telegram:7:11',
        ownerConsole: false,
        recoveryOnly: false,
        startedAt: 1,
        observations: {},
      });

    const record = input();
    expect(record.resolved).toBeNull();
    if (record.resolved) throw new Error('expected a pending record');
    record.appendInput('question');
    record.commitResult('answer');

    expect(
      openConversationRecord({
        sessionStore: store,
        sessionId: session.id,
        message,
        sourceTurnId: '11',
        sourceMessageRef: 'telegram:7:11',
        ownerConsole: false,
        recoveryOnly: true,
        startedAt: 1,
        observations: {},
      }).resolved
    ).toMatchObject({ outcome: 'completed', response: 'answer' });
    store.close();
  });
});
