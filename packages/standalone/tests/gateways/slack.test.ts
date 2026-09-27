import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sockets: [] as unknown[], webClients: [] as unknown[] }));
vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: class MockSocket extends EventEmitter {
    start = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
    constructor() {
      super();
      mocks.sockets.push(this);
    }
  },
}));
vi.mock('@slack/web-api', () => ({
  WebClient: class MockWebClient {
    chat = { postMessage: vi.fn(async () => ({ ok: true, ts: '2.0' })) };
    files = { uploadV2: vi.fn(async () => ({ files: [{ id: 'file_test' }] })) };
    constructor() {
      mocks.webClients.push(this);
    }
  },
}));
import { SlackGateway } from '../../src/gateways/slack.js';
import { OwnerMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

type MockWebClient = {
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: { uploadV2: ReturnType<typeof vi.fn> };
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-owner-'));
  mocks.sockets.length = 0;
  mocks.webClients.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('Slack owner gateway', () => {
  it('acks events, drops non-owners with hashed ids, and accepts duplicate owner messages once', async () => {
    const accepted: unknown[] = [];
    const logs: string[] = [];
    const gateway = new SlackGateway({
      token: 'fixture-bot-token',
      appToken: 'fixture-app-token',
      intake: {
        acceptOwnerMessage: (input) => {
          accepted.push(input);
          return { state: 'accepted' } as never;
        },
        isPending: () => true,
      },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: join(root, 'owner-ledger.json'),
      downloadsDir: join(root, 'downloads'),
      log: (line) => logs.push(line),
    });
    await gateway.start();
    const socket = mocks.sockets[0] as EventEmitter;
    const ack = vi.fn(async () => undefined);
    socket.emit('message', {
      ack,
      event: { channel: 'channel_test', user: 'user_stranger', ts: '1.0', text: 'private' },
    });
    socket.emit('message', {
      ack,
      event: { channel: 'channel_test', user: 'user_owner', ts: '2.0', text: 'owner input' },
    });
    socket.emit('message', {
      ack,
      event: { channel: 'channel_test', user: 'user_owner', ts: '2.0', text: 'owner input' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack).toHaveBeenCalledTimes(3);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ id: 'slack:channel_test:2.0', channelKey: 'channel_test' });
    expect(logs.join('\n')).toContain('sender_hash=');
    expect(logs.join('\n')).not.toContain('user_stranger');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('download unavailable');
      })
    );
    socket.emit('message', {
      ack,
      event: {
        channel: 'channel_test',
        user: 'user_owner',
        ts: '3.0',
        text: 'file request',
        files: [
          {
            id: 'file_test',
            name: 'result.pdf',
            mimetype: 'application/pdf',
            url_private_download: 'https://files.example.test/result.pdf',
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accepted[1]).toMatchObject({
      payload: { attachments: [{ name: 'result.pdf', error: 'download unavailable' }] },
    });
    await gateway.stop();
  });

  it('uploads a file once for an operation id and returns the durable receipt on repeat', async () => {
    const filesRoot = join(root, 'workspace', 'files');
    mkdirSync(filesRoot, { recursive: true });
    const filePath = join(filesRoot, 'result.pdf');
    writeFileSync(filePath, 'result');
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
      intake: { acceptOwnerMessage: () => ({ state: 'accepted' }) as never },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: join(root, 'ledger.json'),
      filesRoot,
    });
    await gateway.start();
    const upload = (mocks.webClients[0] as MockWebClient).files.uploadV2;
    expect(await gateway.sendFile(filePath, undefined, 'operation_test')).toMatchObject({
      messageId: 'file_test',
      size: 6,
    });
    expect(await gateway.sendFile(filePath, undefined, 'operation_test')).toMatchObject({
      idempotent: true,
      size: 6,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    await gateway.stop();
  });

  it('resumes a known-unsent reply after restart and keeps its receipt', async () => {
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new OwnerMessageLedger(ledgerPath);
    ledger.claim('slack:channel_test:message_test', {
      deliveryTarget: 'slack:channel_test',
      payloadIdentity: 'a'.repeat(64),
    });
    ledger.markReady('slack:channel_test:message_test', 'recovered response');
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
      intake: { acceptOwnerMessage: () => ({ state: 'accepted' }) as never },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: ledgerPath,
    });
    await gateway.start();
    await gateway.recoverPendingResponses();
    expect((mocks.webClients[0] as MockWebClient).chat.postMessage).toHaveBeenCalledTimes(1);
    expect(new OwnerMessageLedger(ledgerPath).get('slack:channel_test:message_test')).toMatchObject(
      {
        state: 'delivered',
        messageIds: ['2.0'],
      }
    );
    await gateway.stop();
  });
});
