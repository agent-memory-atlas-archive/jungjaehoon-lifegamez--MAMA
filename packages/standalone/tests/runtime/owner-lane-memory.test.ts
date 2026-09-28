import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledge, readMemoryRecordsInScopes } from '@jungjaehoon/mama-core';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import { createActionSurface, ownerMemoryScopes } from '../../src/runtime/action-surface.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { deliveredPrompt } from '../helpers/delivered-prompt.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('editable owner lane workflows', () => {
  it('renders the text saved by memory.save for each lane', async () => {
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    const root = mkdtempSync(join(tmpdir(), 'owner-lanes-'));
    roots.push(root);
    const database = await openCoreDatabase({ path: join(root, 'state.db') });
    const knowledge = createKnowledge({
      adapter: database.adapter,
      embedder: { embed: vi.fn(async () => new Float32Array(1024).fill(0.25)) },
    });
    const surface = createActionSurface({
      adapter: database.adapter,
      knowledge,
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: ownerMemoryScopes('owner'),
      timeZone: createTimeZoneSetting('UTC'),
      configPath: join(root, 'config.yaml'),
      isOwnerMessageTurn: () => true,
    });
    try {
      const lanes = [
        ['source-delta', 'source_delta', undefined],
        ['hourly-reminder', 'scheduled', 'reminder'],
        ['full-report', 'scheduled', 'full'],
        ['owner-answer', 'owner_message', undefined],
      ] as const;
      for (const [index, [lane, kind, report]] of lanes.entries()) {
        const save = await surface.hostToolCall(
          'memory.save',
          {
            topic: `lane/${lane}`,
            kind: 'workflow',
            summary: `Saved summary for ${lane}.`,
            details: `Saved instruction text for ${lane}.`,
            appliesWhen: `For ${lane} turns`,
            steps: [`Apply the saved instruction for ${lane}.`],
            scopes: [{ kind: 'global', id: 'system' }],
            source: { package: 'standalone', source_type: 'owner-correction' },
          },
          `save-lane-${index}`
        );
        expect(save).toMatchObject({ status: 'completed' });
        const replacement = await surface.hostToolCall(
          'memory.save',
          {
            topic: `lane/${lane}`,
            kind: 'workflow',
            summary: `Replacement summary for ${lane}.`,
            details: `Replacement instruction text for ${lane}.`,
            appliesWhen: `For corrected ${lane} turns`,
            steps: [`Apply the replacement instruction for ${lane}.`],
            scopes: [{ kind: 'global', id: 'system' }],
            source: { package: 'standalone', source_type: 'owner-correction' },
            replaces: [{ id: String(save.data?.id), reason: 'the owner corrected this lane' }],
          },
          `replace-lane-${index}`
        );
        expect(replacement).toMatchObject({ status: 'completed' });

        const delivery = createStimulusDelivery({
          guidanceResolver: async () =>
            readMemoryRecordsInScopes(database.adapter, surface.ownerAccess.scopes, {
              kind: ['lesson', 'preference', 'constraint', 'workflow'],
            }) as never,
          timeZone: createTimeZoneSetting('UTC'),
        });
        const row = {
          id: `stimulus-${index}`,
          stimulusId: kind === 'owner_message' ? 'telegram:fixture' : `stimulus-${index}`,
          principalId: 'owner',
          kind,
          channelKey: 'fixture-channel',
          occurredAt: Date.parse('2026-01-01T09:00:00Z'),
          refs: [],
          preview: [],
          status: 'claimed',
          attempts: 1,
          createdAt: Date.parse('2026-01-01T09:00:00Z'),
          payload:
            kind === 'scheduled'
              ? {
                  report,
                  hourKey: '2026-01-01:09',
                  acknowledgedDeltas: { total: 0, cap: 50, items: [] },
                }
              : kind === 'source_delta'
                ? { refs: [] }
                : { text: 'owner question' },
          coalesceKey: null,
        } as MailboxRow;
        const prompt = await deliveredPrompt(delivery, row, false);

        expect(prompt).toContain(`<lane-instructions lane="${lane}">`);
        expect(prompt).toContain(
          `Owner corrections for this lane (record ${replacement.data?.id}); where they conflict with the lines above, these apply:`
        );
        expect(prompt).toContain(`Replacement summary for ${lane}.`);
        expect(prompt).toContain(`Apply the replacement instruction for ${lane}.`);
        // details explain the record; only the summary and steps are the instruction.
        expect(prompt).not.toContain(`Replacement instruction text for ${lane}.`);
        expect(prompt).not.toContain(`Apply the saved instruction for ${lane}.`);
      }
    } finally {
      await database.close();
    }
  });
});
