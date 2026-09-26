import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '../../src/client/client.js';
import { sendIpcRequest } from '../../src/client/ipc.js';

vi.mock('../../src/client/ipc.js', async (original) => ({
  ...(await original<typeof import('../../src/client/ipc.js')>()),
  sendIpcRequest: vi.fn(async () => ({ ok: true, result: { status: 'completed' } })),
}));
afterEach(() => vi.clearAllMocks());

it('sends caller facts per IPC request without putting them into action input', async () => {
  const home = mkdtempSync(join(tmpdir(), 'caller-client-'));
  try {
    const client = createClient({
      socketPath: join(home, 'runtime.sock'),
      journalPath: join(home, 'journal.jsonl'),
    });
    await Promise.all(
      ['child-a', 'child-b'].map((agent_id) =>
        client.call({
          action: 'fixture.write',
          input: { value: agent_id },
          operationId: agent_id,
          session: { nativeCaller: { session_id: 'session', tool_use_id: agent_id, agent_id } },
        })
      )
    );
    expect(vi.mocked(sendIpcRequest).mock.calls.map((call) => call[1])).toEqual(
      ['child-a', 'child-b'].map((agent_id) => ({
        requestId: expect.any(String),
        kind: 'call',
        credential: undefined,
        action: 'fixture.write',
        input: { value: agent_id },
        operationId: agent_id,
        session: { nativeCaller: { session_id: 'session', tool_use_id: agent_id, agent_id } },
      }))
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
