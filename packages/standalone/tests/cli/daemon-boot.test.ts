import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { TurnIntake } from '../../src/gateways/turn-contract.js';
import {
  bootDaemon,
  type DaemonGateway,
  type DaemonScheduledTick,
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
    acceptSourceDelta: vi.fn<(...args: never[]) => StimulusReceipt>(() => ({
      inputId: 'source-input',
      state: 'accepted',
    })),
    stop: vi.fn(async () => {
      order.push('owner:stop');
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
    };
    const scheduled: DaemonScheduledTick = {
      stop: vi.fn(() => {
        order.push('scheduled:stop');
      }),
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
        startConnectorRuntime: vi.fn(async () => {
          order.push('connectors:start');
          return connectors as never;
        }),
        createTelegramGateway: vi.fn(() => gateway),
        createScheduledTick: vi.fn(() => {
          order.push('scheduled:start');
          return scheduled;
        }),
      },
    });

    expect(order).toEqual(['owner:start', 'connectors:start', 'telegram:start', 'scheduled:start']);
    expect(existsSync(join(mamaRoot, 'workspace', '.git', 'HEAD'))).toBe(true);
    expect(readFileSync(join(mamaRoot, 'workspace', '.git', 'HEAD'), 'utf8')).toBe(
      'ref: refs/heads/main\n'
    );

    await daemon.stop();
    await daemon.stop();

    expect(order).toEqual([
      'owner:start',
      'connectors:start',
      'telegram:start',
      'scheduled:start',
      'scheduled:stop',
      'telegram:stop',
      'connectors:stop',
      'owner:stop',
    ]);
    expect(logs.some((line) => line.includes('boot stage=owner_runtime'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=connectors'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=telegram'))).toBe(true);
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
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      deliverResponse: vi.fn(async () => {}),
    };
    const scheduled: DaemonScheduledTick = { stop: vi.fn(() => {}) };
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot, 'claude'),
      dependencies: {
        createOwnerRuntime: vi.fn(async () => owner as never),
        startConnectorRuntime: vi.fn(async () => ({ stop: vi.fn(async () => {}) }) as never),
        createTelegramGateway: vi.fn(() => gateway),
        createScheduledTick: vi.fn(() => scheduled),
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
