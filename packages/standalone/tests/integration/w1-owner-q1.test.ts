import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { startConnectorRuntime } from '../../src/runtime/connectors.js';
import type { IConnector, NormalizedItem } from '../../src/connectors/framework/types.js';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import { beginModelRun, commitModelRun } from '@jungjaehoon/mama-core';
import type { W1Config } from '../../src/runtime/config.js';
import {
  bootDaemon,
  type DaemonGateway,
  type DaemonLogger,
} from '../../src/cli/commands/daemon.js';
import type { OwnerRuntime } from '../../src/runtime/owner-runtime.js';
import type { TurnIntake, OwnerMessageInput } from '../../src/gateways/turn-contract.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(root: string): W1Config {
  return {
    version: 1,
    agent: {
      backend: 'codex',
      model: 'fixture-model',
      effort: 'medium',
      timeout: 1_000,
      run_token_budget: 100,
    },
    database: { path: join(root, 'memory.db') },
    logging: { level: 'info', file: join(root, 'daemon.log') },
    telegram: {
      enabled: true,
      token: 'fixture-token',
      allowed_chats: ['chat'],
      owner_user_ids: ['owner'],
      polling: false,
    },
  };
}

function fixtureConnector(item: NormalizedItem): IConnector {
  return {
    name: item.source,
    type: 'api',
    init: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    healthCheck: vi.fn(async () => ({
      healthy: true,
      lastPollTime: null,
      lastPollCount: 0,
    })),
    getAuthRequirements: vi.fn(() => []),
    authenticate: vi.fn(async () => true),
    poll: vi.fn(async () => [item]),
  };
}

describe('W1 owner question integration', () => {
  it('stores source, mailbox, model, tool and work evidence before one Telegram delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-w1-owner-q1-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    mkdirSync(mamaRoot, { recursive: true });
    writeFileSync(
      join(mamaRoot, 'connectors.json'),
      JSON.stringify({
        slack: {
          enabled: true,
          pollIntervalMinutes: 60,
          channels: { 'channel-key': { role: 'hub' } },
          auth: { type: 'none' },
        },
      }),
      { encoding: 'utf8' }
    );
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    const item: NormalizedItem = {
      source: 'slack',
      sourceId: 'source-1',
      sourceEntityId: 'entity-1',
      channel: 'channel-key',
      author: 'actor-key',
      content: 'A work update with an assignee and review evidence.',
      timestamp: new Date(now - 1_000),
      observedAt: now,
      type: 'message',
    };
    const actionNames: string[] = [];
    const responses: Array<{ sourceRef: string; response: string }> = [];
    let owner: OwnerRuntime | undefined;
    let gatewayIntake: TurnIntake | undefined;

    const model: NativeSessionHandle = {
      runTurn: vi.fn(async (content, request) => {
        const modelRun = beginModelRun(owner!.database.adapter, {
          model_id: 'fixture-model',
          model_provider: 'codex',
          agent_id: 'owner-agent',
          input_refs: { nativeInputId: request?.nativeInputId ?? null },
        });
        request?.streamCallbacks?.onInputDispatch?.({
          backend: 'codex',
          sessionId: 'fixture-session',
          inputId: request.nativeInputId!,
        });
        request?.streamCallbacks?.onAccepted?.({
          backend: 'codex',
          sessionId: 'fixture-session',
          turnId: `fixture-turn-${request.nativeInputId}`,
        });
        const text = content[0]?.type === 'text' ? (content[0].text ?? '') : '';
        if (text.includes('owner question')) {
          const surface = owner!.surface;
          const session = {
            modelRunId: modelRun.model_run_id,
            gatewayCallId: 'fixture-search',
          };
          const search = await surface.hostToolCall(
            'source.search',
            { source: 'slack', query: 'work', detail: 'full', limit: 10 },
            'tool-search',
            { session }
          );
          actionNames.push('source.search');
          const hit = (search as { data?: { hits?: Array<{ observationRef?: string }> } }).data
            ?.hits?.[0];
          const observationRef = hit?.observationRef;
          if (!observationRef) throw new Error('fixture search omitted an observation ref');
          await surface.hostToolCall(
            'source.read',
            { source: 'slack', observationRef },
            'tool-read',
            { session: { ...session, gatewayCallId: 'fixture-read' } }
          );
          actionNames.push('source.read');
          const created = await surface.hostToolCall(
            'work.create',
            {
              topic: 'work topic',
              summary: 'record the current work',
              sourceRefs: [observationRef],
              links: [
                { relation: 'derived_from', target: { kind: 'observation', id: observationRef } },
              ],
              set: { title: 'current work', assignee: 'assignee-key', roles: [] },
            },
            'tool-create',
            { session: { ...session, gatewayCallId: 'fixture-create' } }
          );
          const commitmentId = (created as { data?: { commitmentId?: string } }).data?.commitmentId;
          if (!commitmentId) throw new Error('fixture work.create omitted a commitment id');
          await surface.hostToolCall('work.list', { limit: 20 }, 'tool-list', {
            session: { ...session, gatewayCallId: 'fixture-list' },
          });
          actionNames.push('work.list');
          commitModelRun(owner!.database.adapter, modelRun.model_run_id, 'fixture answer', 5);
          return {
            response: `Current work is assigned with citation ${observationRef}.`,
            turns: 1,
            history: [],
            totalUsage: { input_tokens: 3, output_tokens: 2 },
            stopReason: 'end_turn' as const,
            modelRunId: null,
            modelRunProvenance: 'backend_no_run' as const,
          };
        }
        commitModelRun(owner!.database.adapter, modelRun.model_run_id, 'fixture source delta', 2);
        return {
          response: 'source delta acknowledged',
          turns: 1,
          history: [],
          totalUsage: { input_tokens: 1, output_tokens: 1 },
          stopReason: 'end_turn' as const,
          modelRunId: null,
          modelRunProvenance: 'backend_no_run' as const,
        };
      }),
      stop: async () => {},
    };

    const logger: DaemonLogger = { info: vi.fn(), error: vi.fn() };
    const gateway: DaemonGateway & { receive(input: OwnerMessageInput): void } = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      deliverResponse: vi.fn(async (sourceRef, response) => {
        responses.push({ sourceRef, response });
      }),
      receive: (input) => {
        gatewayIntake!.acceptOwnerMessage(input);
      },
    };
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger,
      dependencies: {
        createOwnerRuntime: async (options) => {
          owner = await createOwnerRuntime({
            ...options,
            nativeSession: model,
            embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
          });
          return owner;
        },
        startConnectorRuntime: async (options) =>
          startConnectorRuntime({
            ...options,
            loadConnector: async () => fixtureConnector(item),
          }),
        createTelegramGateway: (options) => {
          gatewayIntake = options.intake;
          return gateway;
        },
      },
    });

    gateway.receive({
      id: 'telegram:chat:message-1',
      channelKey: 'chat',
      occurredAt: now,
      text: 'owner question',
    });

    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(actionNames).toEqual(['source.search', 'source.read', 'work.list']);
    expect(responses[0]).toMatchObject({ sourceRef: 'telegram:chat:message-1' });
    expect(responses[0]?.response).toContain('citation');
    const logLines = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
      ([line]) => line as string
    );
    expect(logLines.some((line) => line.includes('stimulus accepted kind=source_delta'))).toBe(
      true
    );
    expect(logLines.some((line) => line.includes('stimulus accepted kind=owner_message'))).toBe(
      true
    );
    expect(logLines.some((line) => line.includes('stimulus delivered kind=owner_message'))).toBe(
      true
    );
    expect(
      logLines.every((line) => !line.includes(item.content) && !line.includes('owner question'))
    ).toBe(true);

    const database = owner!.database.adapter;
    expect(database.prepare('SELECT COUNT(*) AS count FROM mailbox_inputs').get()).toEqual({
      count: 3,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_runs').get()).toEqual({
      count: 2,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM tool_traces').get()).toEqual({
      count: 4,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM commitments').get()).toEqual({
      count: 1,
    });
    expect(
      database
        .prepare('SELECT content FROM connector_event_index WHERE source_id = ?')
        .get('source-1')
    ).toEqual({ content: item.content });
    expect(
      database
        .prepare('SELECT status FROM mailbox_inputs WHERE stimulus_id = ?')
        .get('telegram:chat:message-1')
    ).toEqual({ status: 'acked' });

    await daemon.stop();
  });
});
