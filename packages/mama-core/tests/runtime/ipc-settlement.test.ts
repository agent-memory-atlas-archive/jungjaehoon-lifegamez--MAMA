import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createClient, type Client } from '../../src/client/client.js';
import { sendIpcRequest, newRequestId, IPC_MAX_FRAME_BYTES } from '../../src/client/ipc.js';

// The sandbox denies Unix listen(). Replace only the socket I/O; framing,
// settlement, deadline handling and journal persistence remain real.
vi.mock('node:net', () => ({
  createConnection: () => {
    const socket = new EventEmitter() as EventEmitter & {
      write: (frame: Buffer, callback: () => void) => void;
      destroy: () => void;
    };
    socket.destroy = () => {};
    socket.write = (frame: Buffer, callback: () => void) => {
      const request = JSON.parse(frame.subarray(4).toString());
      const body = Buffer.from(
        JSON.stringify({
          requestId: request.requestId,
          ok: true,
          result: { status: 'completed', data: request.input },
        })
      );
      const reply = Buffer.alloc(body.length + 4);
      reply.writeUInt32BE(body.length);
      body.copy(reply, 4);
      queueMicrotask(() => {
        callback();
        socket.emit('data', reply);
      });
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  },
}));

const socketPath = 'test-socket';
const GOOD_CREDENTIAL = 'fixture';
let dir: string;
let journalPath: string;
let client: Client;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'f3-ipc-'));
  journalPath = join(dir, 'journal.jsonl');
  client = createClient({ socketPath, journalPath });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('F3 client transport boundaries', () => {
  it('F3.17 hashes the JSON sent on the wire when optional fields are undefined', async () => {
    const operationId = 'op_undefined';
    const request = {
      action: 'test.create',
      operationId,
      input: { topic: 'optional', summary: 'wire payload' },
    };
    expect(
      (await client.call({ ...request, input: { ...request.input, extra: undefined } })).status
    ).toBe('completed');
    expect((await client.call(request)).status).toBe('completed');
    const entries = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.operationId === operationId);
    expect(entries).toHaveLength(2);
    expect(entries[0].payloadHash).toBe(entries[1].payloadHash);
  });

  it.each(['circular', 'oversized'])(
    'F3.15 rejects an unencodable %s request without leaving an exchange pending',
    async (kind) => {
      const input: Record<string, unknown> = {};
      if (kind === 'circular') input.self = input;
      else input.body = 'x'.repeat(IPC_MAX_FRAME_BYTES);
      await expect(
        sendIpcRequest(
          socketPath,
          {
            requestId: newRequestId(),
            kind: 'call',
            credential: GOOD_CREDENTIAL,
            action: 'test.create',
            input,
          },
          { timeoutMs: 50 }
        )
      ).rejects.toThrow(/encode|circular|exceeds/i);
    }
  );

  it('F3.15 clears the deadline when a response settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await sendIpcRequest(
        socketPath,
        { requestId: newRequestId(), kind: 'describe', credential: GOOD_CREDENTIAL },
        { timeoutMs: 10000 }
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
