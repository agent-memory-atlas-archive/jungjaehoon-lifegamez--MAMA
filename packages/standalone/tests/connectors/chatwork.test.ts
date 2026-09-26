import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const envName = 'CHATWORK_API_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'room-key': { role: 'hub', name: 'room-display' } },
  auth: { type: 'token', tokenName: envName },
};
const roots: string[] = [];

describe('ChatworkConnector', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-chatwork-token';
  });

  afterEach(() => {
    delete process.env[envName];
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reads the token from the daemon environment and filters by source time', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          message_id: 'old',
          account: { account_id: 1, name: 'actor-old', avatar_image_url: '' },
          body: 'old-content',
          send_time: 10,
          update_time: 10,
        },
        {
          message_id: 'new',
          account: { account_id: 2, name: 'actor-new', avatar_image_url: '' },
          body: 'new-content',
          send_time: 20,
          update_time: 20,
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ChatworkConnector(config);
    await connector.init();
    const items = await connector.poll(new Date(15_000));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'chatwork',
      sourceId: 'room-key:new',
      channel: 'room-display',
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-ChatWorkToken': 'fixture-chatwork-token' },
    });
  });

  it('keeps Chatwork download ids in live observation metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          message_id: 'message-attachment',
          account: { account_id: 3, name: 'actor-attachment', avatar_image_url: '' },
          body: '[download:901] feedback-test.zip',
          send_time: 30,
          update_time: 30,
        },
      ],
    });
    const connector = new ChatworkConnector(config, { fetch: fetchMock });
    await connector.init();

    const [item] = await connector.poll(new Date(0));

    expect(item?.metadata).toMatchObject({
      roomId: 'room-key',
      messageId: 'message-attachment',
      chatworkFileIds: ['901'],
      chatworkFiles: [{ fileId: '901', name: 'feedback-test.zip' }],
    });
  });

  it('matches Chatwork files by message id when the observation has one', async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          file_id: 901,
          message_id: 'message-attachment',
          filename: 'feedback-test.zip',
          filesize: 1_234,
          upload_time: 200,
        },
        {
          file_id: 902,
          message_id: 'other-message',
          filename: 'other-test.zip',
          filesize: 2_345,
          upload_time: 200,
        },
      ],
    });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'room-key',
      messageId: 'message-attachment',
      sourceAtMs: 200_000,
    });

    expect(files).toEqual([
      {
        fileId: '901',
        name: 'feedback-test.zip',
        size: 1_234,
        uploadTime: 200_000,
        matchedBy: 'message_id',
      },
    ]);
    expect(http).toHaveBeenCalledWith(
      'https://api.chatwork.com/v2/rooms/room-key/files',
      expect.objectContaining({ headers: { 'X-ChatWorkToken': 'fixture-chatwork-token' } })
    );
  });

  it('matches Chatwork files by bounded upload time when no message id exists', async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          file_id: 901,
          filename: 'near-test.pdf',
          filesize: 1_234,
          upload_time: 590,
        },
        {
          file_id: 902,
          filename: 'far-test.pdf',
          filesize: 2_345,
          upload_time: 1,
        },
      ],
    });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const files = await connector.listAttachments({
      roomId: 'room-key',
      sourceAtMs: 600_000,
    });

    expect(files).toEqual([
      {
        fileId: '901',
        name: 'near-test.pdf',
        size: 1_234,
        uploadTime: 590_000,
        matchedBy: 'upload_time',
      },
    ]);
  });

  it('downloads a room file through the signed URL without exposing the token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-chatwork-download-'));
    roots.push(root);
    const target = join(root, 'files', '901_feedback-test.zip');
    mkdirSync(join(root, 'files'), { recursive: true });
    const http = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          file_id: 901,
          filename: 'feedback-test.zip',
          filesize: 8,
          upload_time: 200,
          download_url: 'https://download.example.test/file-901',
        }),
      })
      .mockResolvedValueOnce(new Response('file-data'));
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    const result = await connector.downloadAttachment({
      roomId: 'room-key',
      fileId: '901',
      targetPath: target,
    });

    expect(result.size).toBe(9);
    expect(readFileSync(target, 'utf8')).toBe('file-data');
    expect(http.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-ChatWorkToken': 'fixture-chatwork-token' },
    });
    expect(http.mock.calls[1]?.[1]).toBeUndefined();
  });

  it('refuses a Chatwork file response that is not available in the observation room', async () => {
    const http = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();

    await expect(
      connector.downloadAttachment({
        roomId: 'other-room',
        fileId: '901',
        targetPath: '/tmp/unused',
      })
    ).rejects.toThrow(/not available in room other-room/);
  });

  it('does not poll ignored rooms', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ChatworkConnector({
      ...config,
      channels: { ignored: { role: 'ignore' } },
    });
    await connector.init();
    await connector.poll(new Date(0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a batch when a configured room fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const connector = new ChatworkConnector(config);
    await connector.init();
    await expect(connector.poll(new Date(0))).rejects.toThrow(/poll failed/i);
  });
});
