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

describe('owner corrections saved with memory.save', () => {
  it('shows the current correction in full to every kind of turn', async () => {
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    const root = mkdtempSync(join(tmpdir(), 'owner-corrections-'));
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
      const save = await surface.hostToolCall(
        'memory.save',
        {
          topic: 'report style',
          kind: 'workflow',
          summary: 'Reports lead with the conclusion.',
          details: 'The owner asked for it in chat.',
          appliesWhen: 'When writing a report',
          steps: ['Open with the conclusion.'],
          scopes: [{ kind: 'global', id: 'system' }],
          source: { package: 'standalone', source_type: 'owner-correction' },
        },
        'save-correction'
      );
      expect(save).toMatchObject({ status: 'completed' });
      const replacement = await surface.hostToolCall(
        'memory.save',
        {
          topic: 'report style',
          kind: 'workflow',
          summary: 'Reports lead with the conclusion and use section headings.',
          details: 'The owner added headings to the earlier correction.',
          appliesWhen: 'When writing a report',
          steps: ['Open with the conclusion.', 'Use a heading for each section.'],
          scopes: [{ kind: 'global', id: 'system' }],
          source: { package: 'standalone', source_type: 'owner-correction' },
          replaces: [{ id: String(save.data?.id), reason: 'the owner extended the correction' }],
        },
        'replace-correction'
      );
      expect(replacement).toMatchObject({ status: 'completed' });

      const turns = [
        ['source_delta', undefined],
        ['scheduled', 'reminder'],
        ['scheduled', 'full'],
        ['owner_message', undefined],
      ] as const;
      for (const [index, [kind, report]] of turns.entries()) {
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
        const prompt = await deliveredPrompt(delivery, row, true);

        // Every kind of turn in a new session sees the current correction in full.
        expect(prompt).toContain(`${replacement.data?.id} | workflow | report style`);
        expect(prompt).toContain('  Reports lead with the conclusion and use section headings.');
        expect(prompt).toContain('  2. Use a heading for each section.');
        // The replaced record and a record's explanation are not shown.
        expect(prompt).not.toContain(`${save.data?.id} | workflow`);
        expect(prompt).not.toContain('The owner added headings to the earlier correction.');
      }
    } finally {
      await database.close();
    }
  });
});
