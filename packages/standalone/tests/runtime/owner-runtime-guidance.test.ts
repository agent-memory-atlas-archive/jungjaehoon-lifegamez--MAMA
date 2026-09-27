import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { readMemoryRecordsInScopes } from '@jungjaehoon/mama-core';
import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

vi.mock('@jungjaehoon/mama-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jungjaehoon/mama-core')>()),
  startRuntime: vi.fn(async () => ({ stop: async () => {} })),
  readMemoryRecordsInScopes: vi.fn(async () => [
    {
      id: 'guidance-record',
      kind: 'workflow',
      topic: 'release review',
      summary: 'Check the release before sending it.',
      details: 'Read the checklist, then confirm the build.',
      applies_when: 'When preparing a release for review',
      steps: ['Read the checklist', 'Confirm the build'],
      confidence: 0.9,
      status: 'active',
      scopes: [{ kind: 'global', id: 'system' }],
      source: { package: 'test', source_type: 'test' },
      created_at: 1,
      updated_at: 1,
    },
  ]),
}));

vi.mock('../../src/runtime/stimulus-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/stimulus-delivery.js')>();
  return { ...actual, createStimulusDelivery: vi.fn(actual.createStimulusDelivery) };
});

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner guidance resolver', () => {
  it('reads all guidance kinds under the owner scopes without stimulus-text search', async () => {
    const home = mkdtempSync(join(tmpdir(), 'owner-guidance-index-'));
    homes.push(home);
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'fixture-model',
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      timeZone: createTimeZoneSetting('UTC'),
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
      const records = await deliveryOptions.guidanceResolver();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: 'guidance-record', kind: 'workflow' });
      expect(readMemoryRecordsInScopes).toHaveBeenLastCalledWith(
        owner.database.adapter,
        [
          { kind: 'global', id: 'system' },
          { kind: 'user', id: 'owner' },
          { kind: 'channel', id: 'chatwork' },
          { kind: 'project', id: 'chatwork' },
        ],
        { kind: ['lesson', 'preference', 'constraint', 'workflow'] }
      );
    } finally {
      await owner.stop();
    }
  });
});
