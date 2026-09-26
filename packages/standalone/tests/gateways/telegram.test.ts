import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const seams = vi.hoisted(() => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 102 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 103 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  },
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
}));

vi.mock('grammy', () => ({
  InputFile: vi.fn().mockImplementation((path: string) => ({ path })),
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
      seams.handlers.set(event, handler);
    }),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 101, username: 'fixture_bot' },
    api: seams.api,
  })),
}));

import { TelegramGateway } from '../../src/gateways/telegram.js';
import type { OwnerMessageInput, TurnIntake } from '../../src/gateways/turn-contract.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  seams.handlers.clear();
  seams.api.sendMessage.mockClear();
  seams.api.sendPhoto.mockClear();
  seams.api.sendDocument.mockClear();
  seams.api.editMessageText.mockClear();
  seams.api.deleteMessage.mockClear();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 11,
    date: 1_700_000_000,
    chat: { id: 7, type: 'private' },
    from: { id: 9, is_bot: false },
    text: 'owner text',
    ...overrides,
  };
}

function intakeFor(received: OwnerMessageInput[]): TurnIntake {
  return {
    acceptOwnerMessage: vi.fn((input: OwnerMessageInput) => {
      received.push(input);
      return { inputId: 'accepted-1', state: 'accepted' };
    }),
  };
}

async function gatewayFor(
  intake: TurnIntake,
  ledgerPath?: string,
  filesRoot?: string
): Promise<TelegramGateway> {
  const root = mkdtempSync(join(tmpdir(), 'mama-telegram-fixture-'));
  temporaryRoots.push(root);
  const gateway = new TelegramGateway({
    token: 'fixture-token',
    intake,
    messageLedgerPath: ledgerPath ?? join(root, 'telegram-ledger.json'),
    config: {
      allowedChats: ['7'],
      ownerUserIds: ['9'],
      ownerChatId: '7',
      polling: false,
    },
    ...(filesRoot === undefined ? {} : { filesRoot }),
  });
  await gateway.start();
  return gateway;
}

describe('TelegramGateway', () => {
  it('rejects messages outside the configured owner allowlist', async () => {
    const received: OwnerMessageInput[] = [];
    const gateway = await gatewayFor(intakeFor(received));
    const handler = seams.handlers.get('message');
    expect(handler).toBeTypeOf('function');

    await handler!({ message: message({ chat: { id: 8, type: 'private' } }) });
    await handler!({ message: message({ from: { id: 10, is_bot: false } }) });

    expect(received).toEqual([]);
    expect(seams.api.sendMessage).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('submits owner text to the runtime with the Telegram source reference', async () => {
    const received: OwnerMessageInput[] = [];
    const gateway = await gatewayFor(intakeFor(received));
    const handler = seams.handlers.get('message');

    await handler!({ message: message() });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: 'telegram:7:11',
      channelKey: '7',
      text: 'owner text',
    });
    expect(seams.api.sendMessage).toHaveBeenCalledWith(7, '⏳');
    await gateway.stop();
  });

  it('does not submit a Telegram retry after the completed response is delivered', async () => {
    const received: OwnerMessageInput[] = [];
    const gateway = await gatewayFor(intakeFor(received));
    const handler = seams.handlers.get('message');
    const sourceMessageRef = 'telegram:7:11';

    await handler!({ message: message() });
    await gateway.deliverResponse(sourceMessageRef, 'completed answer');
    await gateway.deliverResponse(sourceMessageRef, 'completed answer');
    await handler!({ message: message() });

    expect(received).toHaveLength(1);
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(seams.api.editMessageText).toHaveBeenCalledTimes(1);
    await gateway.stop();
  });

  it('recovers a ready response from the durable ledger without resubmitting the message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-recovery-'));
    temporaryRoots.push(root);
    const ledgerPath = join(root, 'telegram-ledger.json');
    const sourceMessageRef = 'telegram:7:11';
    const ledger = new TelegramMessageLedger(ledgerPath);
    ledger.claim(sourceMessageRef);
    ledger.markReady(sourceMessageRef, 'recovered answer', 'html-v1');
    const received: OwnerMessageInput[] = [];

    const gateway = await gatewayFor(intakeFor(received), ledgerPath);

    expect(received).toEqual([]);
    expect(seams.api.sendMessage).toHaveBeenCalledWith(7, 'recovered answer');
    expect(new TelegramMessageLedger(ledgerPath).get(sourceMessageRef)?.state).toBe('delivered');
    await gateway.stop();
  });

  it('sends an image to the configured owner chat and deduplicates an operation id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-file-'));
    temporaryRoots.push(root);
    const filesRoot = join(root, 'files');
    mkdirSync(filesRoot, { recursive: true });
    const imagePath = join(filesRoot, 'result-test.png');
    writeFileSync(imagePath, 'image-bytes');
    const ledgerPath = join(root, 'telegram-ledger.json');
    const gateway = await gatewayFor(intakeFor([]), ledgerPath, filesRoot);

    const first = await gateway.sendFile(imagePath, 'caption-test', 'file-operation');
    const second = await gateway.sendFile(imagePath, 'caption-test', 'file-operation');

    expect(first).toMatchObject({ sentAs: 'photo', size: 11, messageId: 102 });
    expect(second).toMatchObject({ sentAs: 'photo', size: 11, idempotent: true });
    expect(seams.api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(seams.api.sendPhoto.mock.calls[0]?.[0]).toBe('7');
    expect(seams.api.sendPhoto.mock.calls[0]?.[2]).toEqual({ caption: 'caption-test' });
    await gateway.stop();
  });

  it('sends a non-image file as a document and rejects a changed payload under one operation id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-document-'));
    temporaryRoots.push(root);
    const filesRoot = join(root, 'files');
    mkdirSync(filesRoot, { recursive: true });
    const documentPath = join(filesRoot, 'result-test.pdf');
    const changedPath = join(filesRoot, 'changed-test.pdf');
    writeFileSync(documentPath, 'document');
    writeFileSync(changedPath, 'changed');
    const gateway = await gatewayFor(intakeFor([]), join(root, 'telegram-ledger.json'), filesRoot);

    await gateway.sendFile(documentPath, undefined, 'document-operation');
    await expect(gateway.sendFile(changedPath, undefined, 'document-operation')).rejects.toThrow(
      /binding mismatch/
    );

    expect(seams.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(seams.api.sendPhoto).not.toHaveBeenCalled();
    await gateway.stop();
  });
});
