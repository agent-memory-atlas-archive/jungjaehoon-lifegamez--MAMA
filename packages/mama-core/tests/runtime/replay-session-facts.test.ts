import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCatalog, createDispatcher, startRuntime } from '../../src/index.js';
import type { ActionRegistration } from '../../src/api/catalog.js';
import { sendIpcRequest } from '../../src/client/ipc.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('replay session facts over the action socket', () => {
  it('reads the active ceiling dynamically for separate MCP-style calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-ipc-'));
    roots.push(root);
    let ceiling = 1_500;
    const registration: ActionRegistration = {
      contract: {
        name: 'test.session-facts',
        summary: 'test-only action returning host session facts',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      },
      exec: (_input, context) => ({ replaySourceEndMs: context.session?.replaySourceEndMs }),
    };
    const catalog = createCatalog([registration]);
    const runtime = await startRuntime({
      paths: { socketPath: join(root, 'runtime.sock') },
      catalog,
      dispatch: createDispatcher(catalog),
      principals: [
        {
          access: {
            principalId: 'owner',
            agentId: 'agent',
            scopes: [],
            actions: ['test.session-facts'],
          },
          credentialPath: join(root, 'session-credential'),
        },
      ],
      sessionFacts: () => ({ replaySourceEndMs: ceiling }),
    });
    try {
      const credential = readFileSync(join(root, 'session-credential'), 'utf8').trim();
      const request = (requestId: string) =>
        sendIpcRequest(join(root, 'runtime.sock'), {
          requestId,
          kind: 'call',
          action: 'test.session-facts',
          input: {},
          credential,
        });
      const first = await request('request-one');
      ceiling = 2_500;
      const second = await request('request-two');
      expect(first).toMatchObject({
        ok: true,
        result: { status: 'completed', data: { replaySourceEndMs: 1_500 } },
      });
      expect(second).toMatchObject({
        ok: true,
        result: { status: 'completed', data: { replaySourceEndMs: 2_500 } },
      });
    } finally {
      await runtime.stop();
    }
  });
});
