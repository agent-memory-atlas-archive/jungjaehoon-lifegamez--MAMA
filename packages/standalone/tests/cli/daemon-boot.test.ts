import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { TurnIntake } from '../../src/gateways/turn-contract.js';
import {
  bootDaemon,
  type DaemonGateway,
  type DaemonLogger,
} from '../../src/cli/commands/daemon.js';
import type { W1Config } from '../../src/runtime/config.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(root: string, backend: 'codex' | 'claude' = 'codex'): W1Config {
  return {
    version: 1,
    agent: {
      backend,
      model: 'fixture-model',
      effort: 'medium',
      max_turns: 20,
      timeout: 1_000,
      run_token_budget: 100,
      ...(backend === 'claude' ? { tools: { mcp_config: join(root, 'runtime', 'mcp.json') } } : {}),
    },
    database: { path: join(root, 'memory.db') },
    logging: { level: 'info', file: join(root, 'daemon.log') },
    telegram: {
      enabled: true,
      token: 'fixture-token',
      owner_chat_id: 'chat',
      allowed_chats: ['chat'],
      owner_user_ids: ['owner'],
      polling: false,
    },
  };
}

function ownerDouble(order: string[]) {
  const intake: TurnIntake = {
    acceptOwnerMessage: vi.fn(() => ({ inputId: 'owner-input', state: 'accepted' })),
  };
  return {
    intake,
    surface: {
      dispatch: vi.fn(),
      ownerAccess: {},
    },
    acceptSourceDelta: vi.fn<(...args: never[]) => StimulusReceipt>(() => ({
      inputId: 'source-input',
      state: 'accepted',
    })),
    stop: vi.fn(async () => {
      order.push('owner:stop');
    }),
  };
}

function viewerDouble(order: string[]) {
  return {
    port: 3847,
    server: null,
    start: vi.fn(async () => {
      order.push('viewer:start');
    }),
    stop: vi.fn(async () => {
      order.push('viewer:stop');
    }),
  };
}

describe('daemon bootstrap', () => {
  it('starts producers after the owner runtime and stops them in reverse order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-boot-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    const order: string[] = [];
    const logs: string[] = [];
    const logger: DaemonLogger = {
      info: (line) => logs.push(`info:${line}`),
      error: (line) => logs.push(`error:${line}`),
    };
    const owner = ownerDouble(order);
    const viewer = viewerDouble(order);
    const connectors = {
      stop: vi.fn(async () => {
        order.push('connectors:stop');
      }),
    };
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {
        order.push('telegram:start');
      }),
      stop: vi.fn(async () => {
        order.push('telegram:stop');
      }),
      deliverResponse: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ sentAs: 'document' as const, size: 0 })),
    };
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger,
      dependencies: {
        createOwnerRuntime: vi.fn(async () => {
          order.push('owner:start');
          return owner as never;
        }),
        createViewerServer: vi.fn(() => viewer as never),
        startConnectorRuntime: vi.fn(async () => {
          order.push('connectors:start');
          return connectors as never;
        }),
        createTelegramGateway: vi.fn((options) => {
          expect(options.config?.ownerChatId).toBe('chat');
          expect(options.filesRoot).toBe(join(mamaRoot, 'workspace', 'files'));
          expect(options.workspaceDir).toBe(join(mamaRoot, 'workspace'));
          return gateway;
        }),
      },
    });

    expect(order).toEqual(['owner:start', 'viewer:start', 'connectors:start', 'telegram:start']);
    expect(existsSync(join(mamaRoot, 'workspace', '.git', 'HEAD'))).toBe(true);
    expect(readFileSync(join(mamaRoot, 'workspace', '.git', 'HEAD'), 'utf8')).toBe(
      'ref: refs/heads/main\n'
    );

    await daemon.stop();
    await daemon.stop();

    expect(order).toEqual([
      'owner:start',
      'viewer:start',
      'connectors:start',
      'telegram:start',
      'telegram:stop',
      'connectors:stop',
      'viewer:stop',
      'owner:stop',
    ]);
    expect(logs.some((line) => line.includes('boot stage=owner_runtime'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=connectors'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=viewer'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=telegram'))).toBe(true);
    expect(logs.filter((line) => line === 'info:owner policy: none')).toHaveLength(1);
  });

  it('logs a loaded owner policy once and passes its provider to the owner runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-owner-policy-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    mkdirSync(mamaRoot, { recursive: true });
    writeFileSync(join(mamaRoot, 'owner-policy.md'), 'owner policy fixture\n', 'utf8');
    const logs: string[] = [];
    const logger: DaemonLogger = {
      info: (line) => logs.push(`info:${line}`),
      error: (line) => logs.push(`error:${line}`),
    };
    const owner = ownerDouble([]);
    const viewer = viewerDouble([]);
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      deliverResponse: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ sentAs: 'document' as const, size: 0 })),
    };
    let policyContent: string | null | undefined;
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger,
      dependencies: {
        createOwnerRuntime: vi.fn(async (options) => {
          policyContent = options.ownerPolicyProvider?.().content;
          return owner as never;
        }),
        createViewerServer: vi.fn(() => viewer as never),
        startConnectorRuntime: vi.fn(async () => ({ stop: vi.fn(async () => {}) }) as never),
        createTelegramGateway: vi.fn(() => gateway),
      },
    });

    expect(logs.filter((line) => line === 'info:owner policy: loaded')).toHaveLength(1);
    expect(policyContent).toBe('owner policy fixture\n');
    await daemon.stop();
  });

  it('replay mode starts the owner and feeder without live connectors or Telegram', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-replay-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    const owner = ownerDouble([]);
    const logs: string[] = [];
    const logger: DaemonLogger = {
      info: (line) => logs.push(`info:${line}`),
      error: (line) => logs.push(`error:${line}`),
    };
    // The read-only viewer serves the owner while the replay fills the records.
    const viewer = {
      port: 0,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const replay = vi.fn(async (context: { owner: unknown }) => {
      expect(context.owner).toBe(owner);
      expect(viewer.start).toHaveBeenCalledOnce();
    });
    const daemon = await bootDaemon({
      mode: 'replay',
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger,
      replay,
      dependencies: {
        createOwnerRuntime: vi.fn(async () => owner as never),
        createViewerServer: vi.fn(() => viewer as never),
        startConnectorRuntime: vi.fn(async () => {
          throw new Error('live connectors must not start in replay mode');
        }),
        createTelegramGateway: vi.fn(() => {
          throw new Error('Telegram must not start in replay mode');
        }),
      },
    });

    expect(replay).toHaveBeenCalledOnce();
    expect(logs.filter((line) => line === 'info:replay collectors: disabled')).toHaveLength(1);
    expect(daemon.connectors).toBeNull();
    expect(daemon.gateway).toBeNull();
    expect(daemon.viewer).toBe(viewer);
    await daemon.stop();
    expect(viewer.stop).toHaveBeenCalledOnce();
  });

  it('does not remove preserved W5 sources while creating Claude isolation files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-isolation-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    const preservedBrief = join(mamaRoot, 'briefs', 'keep.md');
    const preservedSkill = join(mamaRoot, '.codex', 'skills', 'keep.md');
    mkdirSync(join(mamaRoot, 'briefs'), { recursive: true });
    mkdirSync(join(mamaRoot, '.codex', 'skills'), { recursive: true });
    writeFileSync(preservedBrief, 'preserved', { encoding: 'utf8' });
    writeFileSync(preservedSkill, 'preserved', { encoding: 'utf8' });
    const order: string[] = [];
    const owner = ownerDouble(order);
    const viewer = viewerDouble(order);
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      deliverResponse: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ sentAs: 'document' as const, size: 0 })),
    };
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot, 'claude'),
      dependencies: {
        createOwnerRuntime: vi.fn(async () => owner as never),
        createViewerServer: vi.fn(() => viewer as never),
        startConnectorRuntime: vi.fn(async () => ({ stop: vi.fn(async () => {}) }) as never),
        createTelegramGateway: vi.fn(() => gateway),
      },
    });

    expect(existsSync(join(mamaRoot, 'workspace', '.git', 'HEAD'))).toBe(true);
    expect(existsSync(join(mamaRoot, '.empty-plugins'))).toBe(true);
    expect(existsSync(join(mamaRoot, 'runtime', 'mcp.json'))).toBe(true);
    expect(readFileSync(preservedBrief, 'utf8')).toBe('preserved');
    expect(readFileSync(preservedSkill, 'utf8')).toBe('preserved');

    await daemon.stop();
  });
});
