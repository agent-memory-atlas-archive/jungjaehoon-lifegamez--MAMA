import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionContext } from '@jungjaehoon/mama-core';
import type { StoredSourceReader } from '../../src/api/stored-source-reader.js';
import {
  createAttachmentActionRegistrations,
  type AttachmentActionPorts,
} from '../../src/api/attachment-actions.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const access = {
  principalId: 'owner-test',
  agentId: 'agent-test',
  actions: ['source.attachment.list', 'source.attachment.download', 'deliver.telegram.file'],
  connectors: ['chatwork', 'slack'],
  connectorWideRead: ['chatwork', 'slack'],
  scopes: [],
} as unknown as ActionContext['access'];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mama-attachment-actions-'));
  roots.push(value);
  return value;
}

function observation(source: 'chatwork' | 'slack', metadata: Record<string, unknown>) {
  return {
    source,
    observationRef: 'obs-test',
    sourceId: `${source}:message-test`,
    sourceAt: 600_000,
    channel: source === 'chatwork' ? 'room-display' : 'channel-display',
    metadata,
    content: 'message body',
  };
}

function action(
  ports: AttachmentActionPorts,
  name: string
): NonNullable<ReturnType<typeof createAttachmentActionRegistrations>[number]>['exec'] {
  const registration = createAttachmentActionRegistrations(ports).find(
    (entry) => entry.contract.name === name
  );
  if (!registration) throw new Error(`missing test action ${name}`);
  return registration.exec;
}

function portsFor(
  workspaceDir: string,
  storedObservation: Record<string, unknown>,
  connector: Record<string, unknown>,
  telegram?: Record<string, unknown>
): AttachmentActionPorts {
  const stored = {
    readObservation: vi.fn().mockResolvedValue(storedObservation),
  } as unknown as StoredSourceReader;
  const registry = {
    get: vi.fn().mockReturnValue(connector),
  };
  return {
    stored,
    connectors: () => registry as never,
    workspaceDir,
    telegram: () => telegram as never,
  };
}

describe('attachment actions', () => {
  it('lists Slack attachments from the observation metadata and room', async () => {
    const workspace = root();
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([
        {
          fileId: 'F-901',
          name: 'feedback-test.pdf',
          size: 1_234,
          uploadTime: 200_000,
          matchedBy: 'metadata_file_id',
        },
      ]),
      downloadAttachment: vi.fn(),
    };
    const list = action(
      portsFor(
        workspace,
        observation('slack', { channelId: 'channel-test', slackFileIds: ['F-901'] }),
        connector
      ),
      'source.attachment.list'
    );

    const result = await list({ observationRef: 'obs-test' }, { access, operationId: 'op-list' });

    expect(connector.listAttachments).toHaveBeenCalledWith({
      roomId: 'channel-test',
      sourceAtMs: 600_000,
      fileIds: ['F-901'],
      fileIdRule: 'metadata_file_id',
    });
    expect(result).toMatchObject({
      observationRef: 'obs-test',
      connector: 'slack',
      files: [{ fileId: 'F-901', name: 'feedback-test.pdf', matchedBy: 'metadata_file_id' }],
    });
  });

  it('lists a Slack attachment from the stored slack_file marker when metadata is absent', async () => {
    const workspace = root();
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([]),
      downloadAttachment: vi.fn(),
    };
    const stored = observation('slack', { channelId: 'channel-test' });
    stored.content = 'message body (slack_file:F-902)';
    const list = action(portsFor(workspace, stored, connector), 'source.attachment.list');

    await list({ observationRef: 'obs-test' }, { access, operationId: 'op-marker' });

    expect(connector.listAttachments).toHaveBeenCalledWith({
      roomId: 'channel-test',
      sourceAtMs: 600_000,
      fileIds: ['F-902'],
      fileIdRule: 'text_marker',
    });
  });

  it('downloads into the workspace connector room directory and returns its size', async () => {
    const workspace = root();
    mkdirSync(join(workspace, 'files'), { recursive: true });
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([
        {
          fileId: '901',
          name: 'feedback bad.pdf',
          size: 5,
          uploadTime: 600_000,
          matchedBy: 'metadata_file_id',
        },
      ]),
      downloadAttachment: vi.fn(async ({ targetPath }: { targetPath: string }) => {
        writeFileSync(targetPath, 'bytes');
        return {
          descriptor: {
            fileId: '901',
            name: 'feedback bad.pdf',
            size: 5,
            uploadTime: 600_000,
            matchedBy: 'upload_time',
          },
          size: 5,
        };
      }),
    };
    const download = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), connector),
      'source.attachment.download'
    );

    const result = await download(
      { observationRef: 'obs-test', fileId: '901' },
      { access, operationId: 'op-download' }
    );

    const expected = join(workspace, 'files', 'chatwork', '501', '901_feedback bad.pdf');
    expect(connector.downloadAttachment).toHaveBeenCalledWith({
      roomId: '501',
      fileId: '901',
      targetPath: expected,
    });
    expect(result).toEqual({
      observationRef: 'obs-test',
      connector: 'chatwork',
      fileId: '901',
      path: expected,
      size: 5,
    });
  });

  it('surfaces a provider room refusal and does not create a download', async () => {
    const workspace = root();
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([
        {
          fileId: '901',
          name: 'feedback-test.pdf',
          size: 5,
          uploadTime: 600_000,
          matchedBy: 'metadata_file_id',
        },
      ]),
      downloadAttachment: vi
        .fn()
        .mockRejectedValue(new Error('Chatwork file 901 is not available in room 501')),
    };
    const download = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), connector),
      'source.attachment.download'
    );

    await expect(
      download(
        { observationRef: 'obs-test', fileId: '901' },
        { access, operationId: 'op-download' }
      )
    ).rejects.toThrow(/not available in room 501/);
  });

  it('refuses every Telegram path class outside the workspace files root', async () => {
    const workspace = root();
    const files = join(workspace, 'files');
    mkdirSync(files, { recursive: true });
    const outside = join(workspace, 'outside.txt');
    const regular = join(files, 'regular.txt');
    const symlink = join(files, 'link.txt');
    const directory = join(files, 'directory');
    const oversized = join(files, 'oversized.bin');
    writeFileSync(outside, 'outside');
    writeFileSync(regular, 'regular');
    symlinkSync(outside, symlink);
    mkdirSync(directory);
    writeFileSync(oversized, '');
    truncateSync(oversized, 50 * 1024 * 1024 + 1);
    const sender = { sendFile: vi.fn() };
    const deliver = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), {}, sender),
      'deliver.telegram.file'
    );

    await expect(deliver({ path: outside }, { access, operationId: 'op-outside' })).rejects.toThrow(
      /under the workspace files directory/
    );
    await expect(deliver({ path: symlink }, { access, operationId: 'op-symlink' })).rejects.toThrow(
      /symlink/
    );
    await expect(
      deliver({ path: directory }, { access, operationId: 'op-directory' })
    ).rejects.toThrow(/regular file/);
    await expect(deliver({ path: oversized }, { access, operationId: 'op-large' })).rejects.toThrow(
      /Telegram upload limit/
    );
    expect(sender.sendFile).not.toHaveBeenCalled();
  });

  it('sends the validated path through the late-bound Telegram port with the operation id', async () => {
    const workspace = root();
    const files = join(workspace, 'files');
    mkdirSync(files, { recursive: true });
    const path = join(files, 'result.txt');
    writeFileSync(path, 'result');
    const sender = {
      sendFile: vi.fn().mockResolvedValue({ messageId: 22, sentAs: 'document', size: 6 }),
    };
    const deliver = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), {}, sender),
      'deliver.telegram.file'
    );

    const result = await deliver(
      { path, caption: 'result caption' },
      { access, operationId: 'op-file' }
    );

    const realPath = realpathSync(path);
    expect(sender.sendFile).toHaveBeenCalledWith(realPath, 'result caption', 'op-file');
    expect(result).toMatchObject({ path: realPath, size: 6, sentAs: 'document' });
  });
});
