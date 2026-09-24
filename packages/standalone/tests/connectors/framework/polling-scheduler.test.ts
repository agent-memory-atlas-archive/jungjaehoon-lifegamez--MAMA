import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorRegistry } from '../../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../../src/connectors/framework/polling-scheduler.js';
import { RawStore } from '../../../src/storage/source-archive.js';
import type { IConnector } from '../../../src/connectors/framework/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function fakeConnector(
  items: IConnector['poll'] extends (since: Date) => Promise<infer R> ? R : never
): IConnector {
  return {
    name: 'slack',
    type: 'api',
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, lastPollTime: null, lastPollCount: 0 }),
    getAuthRequirements: vi.fn().mockReturnValue([]),
    authenticate: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue(items),
  };
}

describe('PollingScheduler', () => {
  it('runs raw save, index projection, and source-delta handoff in order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const order: string[] = [];
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
      rawIndexSink: async () => {
        order.push('index');
      },
    });
    const registry = new ConnectorRegistry();
    const connector = fakeConnector([
      {
        source: 'slack',
        sourceId: 'source-key',
        channel: 'display-room',
        author: 'actor-key',
        content: 'source-content',
        timestamp: new Date('2024-01-01T12:00:00.000Z'),
        type: 'message',
      },
    ]);
    registry.register('slack', connector);
    await scheduler.pollAll(
      registry,
      { slack: { 'channel-key': { role: 'hub', name: 'display-room' } } },
      async (delta) => {
        order.push('delta');
        expect(delta).toMatchObject({
          collector: 'slack',
          channel: 'channel-key',
          coalesceKey: 'source:slack:channel-key',
        });
        expect(delta.refs).toHaveLength(1);
      }
    );
    expect(order).toEqual(['index', 'delta']);
    expect(scheduler.getLastPollTime('slack')?.toISOString()).toBe('2024-01-02T00:00:00.000Z');
    expect(rawStore.query('slack', new Date(0))[0]?.channel).toBe('channel-key');
    rawStore.close();
  });

  it('does not advance state when the handoff fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-fail-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => 10_000,
      rawIndexSink: vi.fn(),
    });
    const registry = new ConnectorRegistry();
    registry.register(
      'slack',
      fakeConnector([
        {
          source: 'slack',
          sourceId: 'source-key',
          channel: 'channel-key',
          author: 'actor-key',
          content: 'source-content',
          timestamp: new Date(1),
          type: 'message',
        },
      ])
    );
    await scheduler.pollAll(registry, { slack: { 'channel-key': { role: 'hub' } } }, async () => {
      throw new Error('handoff failed');
    });
    expect(scheduler.getLastPollTime('slack')).toBeUndefined();
    expect(rawStore.listPendingProjections('slack')).toHaveLength(1);
    rawStore.close();
  });

  it('hands off every pending projection when one poll returns more than one page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-page-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
      rawIndexSink: vi.fn(),
    });
    const registry = new ConnectorRegistry();
    const items = Array.from({ length: 1001 }, (_, index) => ({
      source: 'slack',
      sourceId: `source-${index}`,
      channel: 'channel-key',
      author: 'actor-key',
      content: `source-content-${index}`,
      timestamp: new Date(1_000 + index),
      type: 'message' as const,
    }));
    registry.register('slack', fakeConnector(items));
    let refs = 0;
    await scheduler.pollAll(
      registry,
      { slack: { 'channel-key': { role: 'hub' } } },
      async (delta) => {
        refs += delta.refs.length;
      }
    );
    expect(refs).toBe(1001);
    rawStore.close();
  });

  it('does not overlap a connector interval with an active poll', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-overlap-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const scheduler = new PollingScheduler(rawStore, root, { rawIndexSink: vi.fn() });
    const registry = new ConnectorRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = fakeConnector([]);
    (connector.poll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await gate;
      return [];
    });
    registry.register('slack', connector);
    const first = scheduler.pollConnector('slack', registry, { slack: {} }, vi.fn());
    await Promise.resolve();
    const second = scheduler.pollConnector('slack', registry, { slack: {} }, vi.fn());
    expect(connector.poll).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    rawStore.close();
  });
});
