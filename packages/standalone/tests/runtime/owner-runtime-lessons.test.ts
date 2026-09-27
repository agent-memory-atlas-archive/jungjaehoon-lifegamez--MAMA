import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { recallMemory } from '@jungjaehoon/mama-core';
import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';

vi.mock('@jungjaehoon/mama-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jungjaehoon/mama-core')>()),
  startRuntime: vi.fn(async () => ({ stop: async () => {} })),
  recallMemory: vi.fn(async () => ({ memories: [{ summary: 'Use the saved owner rule' }] })),
}));

vi.mock('../../src/runtime/stimulus-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/stimulus-delivery.js')>();
  return { ...actual, createStimulusDelivery: vi.fn(actual.createStimulusDelivery) };
});

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner lesson resolver', () => {
  it('recalls lessons, preferences and constraints for later owner turns', async () => {
    const home = mkdtempSync(join(tmpdir(), 'owner-rule-recall-'));
    homes.push(home);
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'fixture-model',
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [{ kind: 'global', id: 'system' }],
      connectors: ['chatwork'],
      nativeSession: { stop: async () => {} },
      maxTurns: 10,
      timeout: 1_000,
    });
    try {
      const [deliveryOptions] = vi.mocked(createStimulusDelivery).mock.calls.at(-1)!;
      expect(await deliveryOptions.lessonResolver('deadline reminder')).toEqual([
        { summary: 'Use the saved owner rule' },
      ]);
      expect(recallMemory).toHaveBeenLastCalledWith(owner.database.adapter, 'deadline reminder', {
        kind: ['lesson', 'preference', 'constraint'],
        scopes: [
          { kind: 'global', id: 'system' },
          { kind: 'user', id: 'owner' },
          { kind: 'channel', id: 'chatwork' },
          { kind: 'project', id: 'chatwork' },
        ],
        limit: 3,
        includeRelated: false,
        skipGraphExpansion: true,
      });
    } finally {
      await owner.stop();
    }
  });
});
