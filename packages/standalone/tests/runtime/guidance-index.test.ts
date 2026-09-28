import { describe, expect, it, vi } from 'vitest';
import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { deliveredPrompt } from '../helpers/delivered-prompt.js';

function row(kind: string, id: string) {
  return {
    id,
    stimulusId: id,
    principalId: 'owner',
    kind: kind === 'replay_delta' ? 'source_delta' : kind,
    channelKey: 'owner-channel',
    occurredAt: 10,
    refs: [],
    preview: [],
    status: 'claimed',
    attempts: 1,
    createdAt: 10,
    payload:
      kind === 'source_delta'
        ? { refs: [] }
        : kind === 'scheduled'
          ? id.includes('reminder')
            ? {
                report: 'reminder',
                hourKey: '2026-09-27:15',
                acknowledgedDeltas: { total: 0, cap: 50, items: [] },
              }
            : { report: 'full', hourKey: '2026-09-27:15' }
          : kind === 'replay_delta'
            ? { refs: [], replay: { windowStartMs: 0, windowEndMs: 1000 } }
            : { text: `${kind} stimulus` },
    coalesceKey: null,
  };
}

function deliver(
  delivery: ReturnType<typeof createStimulusDelivery>,
  kind: string,
  id: string,
  isNewSession: boolean,
  failAfterPreparation = false
): Promise<string> {
  return deliveredPrompt(delivery, row(kind, id) as never, isNewSession, failAfterPreparation);
}

describe('owner guidance index delivery', () => {
  it('sends the full index and recent exchanges once per session', async () => {
    const records = [
      {
        id: 'memory-guidance-1',
        kind: 'lesson',
        topic: 'release review',
        applies_when: 'When a release is ready for review',
        summary: 'Review the build before sending it.',
        status: 'active',
        updated_at: 1,
      },
    ];
    const guidanceResolver = vi.fn(async () => records);
    const delivery = createStimulusDelivery({
      guidanceResolver,
      timeZone: createTimeZoneSetting('UTC'),
      recentOwnerExchanges: async () => [
        { owner: 'A recent request', answer: 'A delivered answer' },
      ],
    } as never);

    const first = await deliver(delivery, 'owner_message', 'first-input', true);
    expect(first).toContain('<guidance-index>');
    expect(first).toContain(
      'memory-guidance-1 | lesson | release review | applies when: When a release is ready for review'
    );
    expect(first).toContain('<recent_owner_exchanges>');
    expect(first).toContain('A recent request');

    const second = await deliver(delivery, 'owner_message', 'second-input', false);
    expect(second).not.toContain('<guidance-index>');
    expect(second).not.toContain('<guidance-delta>');

    const restarted = await deliver(delivery, 'owner_message', 'third-input', true);
    expect(restarted).toContain('<guidance-index>');
    expect(guidanceResolver).toHaveBeenCalledTimes(3);
  });

  it('sends only records added, revised, or retired since the previous delivery', async () => {
    const records = [
      {
        id: 'memory-guidance-revised',
        kind: 'lesson',
        topic: 'release review',
        applies_when: 'When a release is ready for review',
        summary: 'Review the build before sending it.',
        status: 'active',
        updated_at: 1,
      },
      {
        id: 'memory-guidance-retired',
        kind: 'constraint',
        topic: 'old approval route',
        summary: 'Use the old approval route.',
        status: 'active',
        updated_at: 2,
      },
    ];
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => records,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);
    await deliver(delivery, 'owner_message', 'initial-input', true);

    records[0] = {
      ...records[0]!,
      applies_when: 'When a release needs a second review',
      updated_at: 3,
    };
    records[1] = { ...records[1]!, status: 'stale', updated_at: 4 };
    records.push({
      id: 'memory-guidance-added',
      kind: 'workflow',
      topic: 'publish a release',
      applies_when: 'When publishing an approved release',
      steps: ['Read the checklist', 'Confirm the build', 'Send the summary'],
      summary: 'Publish an approved release.',
      status: 'active',
      updated_at: 5,
    });

    const delta = await deliver(delivery, 'scheduled', 'scheduled-input', false);
    expect(delta).toContain('<guidance-delta>');
    expect(delta).toContain('memory-guidance-revised');
    expect(delta).toContain('When a release needs a second review');
    expect(delta).toContain('memory-guidance-added | workflow | publish a release');
    expect(delta).toContain('retired: memory-guidance-retired | constraint | old approval route');
    expect(delta).not.toContain('Review the build before sending it.');

    const unchanged = await deliver(delivery, 'native_event', 'native-input', false);
    expect(unchanged).not.toContain('<guidance-delta>');
  });

  it('uses the same session index for owner, source-delta, scheduled, and native-event turns', async () => {
    const guidanceResolver = vi.fn(async () => []);
    const delivery = createStimulusDelivery({
      guidanceResolver,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);
    await deliver(delivery, 'owner_message', 'owner-input', true);
    for (const [kind, id] of [
      ['source_delta', 'source-input'],
      ['scheduled', 'schedule-input'],
      ['native_event', 'native-input'],
    ]) {
      const prompt = await deliver(delivery, kind, id, false);
      expect(prompt).not.toContain('<guidance-index>');
      expect(prompt).not.toContain('<guidance-delta>');
    }
    expect(guidanceResolver).toHaveBeenCalledTimes(4);
    expect(guidanceResolver.mock.calls.every((args) => args.length === 0)).toBe(true);
  });

  it('does not advance the delivered index when the model turn fails after preparation', async () => {
    const records: Array<Record<string, unknown>> = [];
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => records as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);
    await deliver(delivery, 'owner_message', 'initial-input', true);
    records.push({
      id: 'memory-guidance-pending',
      kind: 'lesson',
      topic: 'review step',
      applies_when: 'When reviewing a release',
      summary: 'Read the checklist.',
      status: 'active',
      updated_at: 1,
    });

    await expect(deliver(delivery, 'owner_message', 'failed-input', false, true)).rejects.toThrow(
      'model turn did not complete'
    );
    const retry = await deliver(delivery, 'owner_message', 'retry-input', false);
    expect(retry).toContain('<guidance-delta>');
    expect(retry).toContain('added: memory-guidance-pending');
  });

  it('keeps lane workflows out of the session guidance index and delta', async () => {
    const records: Array<Record<string, unknown>> = [];
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => records as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    records.push({
      id: 'lane-topic-lesson',
      kind: 'lesson',
      topic: 'lane/source-delta',
      applies_when: 'When a delta mentions a vendor',
      summary: 'A lesson saved under a lane topic is still guidance.',
      status: 'active',
      updated_at: 1,
    });
    const initial = await deliver(delivery, 'owner_message', 'lane-index-first', true);
    expect(initial).toContain('lane-topic-lesson | lesson | lane/source-delta');
    records.push({
      id: 'lane-record',
      kind: 'workflow',
      topic: 'lane/source-delta',
      applies_when: 'For live source deltas',
      steps: ['Replace this lane instruction.'],
      summary: 'Editable lane workflow',
      status: 'active',
      updated_at: 1,
    });
    const next = await deliver(delivery, 'scheduled', 'lane-index-next', false);
    expect(next).not.toContain('lane-record | workflow');
    expect(next).not.toContain('<guidance-index>');
  });

  it('renders each lane default and the current workflow once in turn content', async () => {
    const current: Array<Record<string, unknown>> = [];
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => current as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    for (const [kind, id, lane] of [
      ['source_delta', 'lane-default-delta', 'source-delta'],
      ['scheduled', 'lane-default-reminder', 'hourly-reminder'],
      ['scheduled', 'lane-default-full', 'full-report'],
      ['owner_message', 'lane-default-owner', 'owner-answer'],
    ] as const) {
      const prompt = await deliver(delivery, kind, id, false);
      expect(prompt).toContain(`<lane-instructions lane="${lane}">`);
      expect(prompt).not.toContain('Owner corrections for this lane');
      expect(prompt.match(/<lane-instructions /g)).toHaveLength(1);
      const defaultText = {
        'source-delta': 'Decide whether each live source delta is chatter',
        'hourly-reminder': 'Use what this owner session already knows',
        'full-report': 'Call source.recent for changes since the supplied prior full-report time',
        'owner-answer': 'Keep the answer concise, with no working notes',
      }[lane];
      expect(prompt).toContain(defaultText);
      if (lane === 'owner-answer') {
        // An owner turn that changes work keeps every still-true card on the board.
        expect(prompt).toContain('preserving every card that remains true');
      }
      if (lane === 'source-delta') {
        expect(prompt).toContain('Set eventDatetime to the source event time');
        expect(prompt).toContain('assignee and roles the evidence points to');
        expect(prompt).toContain('Record "unconfirmed" only when no observation points to anyone');
        expect(prompt).toContain('Read work.show only when a revise is rejected as stale');
        expect(prompt).toContain('end_of_window_instructions');
        expect(
          prompt.match(/Update every board section the item appears in or leaves/g)
        ).toHaveLength(1);
      }
    }

    for (const [kind, id, lane] of [
      ['source_delta', 'lane-saved-delta', 'source-delta'],
      ['scheduled', 'lane-saved-reminder', 'hourly-reminder'],
      ['scheduled', 'lane-saved-full', 'full-report'],
      ['owner_message', 'lane-saved-owner', 'owner-answer'],
    ] as const) {
      current.length = 0;
      current.push({
        id: `saved-${lane}`,
        kind: 'workflow',
        topic: `lane/${lane}`,
        summary: `Saved summary for ${lane}.`,
        details: `Saved instruction text for ${lane}.`,
        applies_when: `For ${lane}`,
        steps: [`Apply the saved ${lane} instruction.`],
        status: 'active',
        updated_at: 1,
      });
      const prompt = await deliver(delivery, kind, id, false);
      expect(prompt).toContain(`<lane-instructions lane="${lane}">`);
      // A correction sits on top of the default: the default lines stay and the correction wins.
      expect(prompt).toContain(
        {
          'source-delta': 'Decide whether each live source delta is chatter',
          'hourly-reminder': 'Use what this owner session already knows',
          'full-report': 'Call source.recent for changes since the supplied prior full-report time',
          'owner-answer': 'Keep the answer concise, with no working notes',
        }[lane]
      );
      expect(prompt).toContain(
        `Owner corrections for this lane (record saved-${lane}); where they conflict with the lines above, these apply:`
      );
      expect(prompt).toContain(`Saved summary for ${lane}.`);
      expect(prompt).toContain(`Apply the saved ${lane} instruction.`);
      expect(prompt).not.toContain(`Saved instruction text for ${lane}.`);
      expect(prompt.match(/<lane-instructions /g)).toHaveLength(1);
    }
  });

  it('keeps the fixed delta marker contract when its lane workflow omits markers', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () =>
        [
          {
            id: 'delta-without-markers',
            kind: 'workflow',
            topic: 'lane/source-delta',
            summary: 'Handle the change.',
            applies_when: 'For deltas',
            steps: ['Record changed work.'],
            status: 'active',
            updated_at: 1,
          },
        ] as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'source_delta', 'delta-marker-contract', false);
    expect(prompt).toContain(
      'End this turn with exactly one marker: [notify] followed by the message the owner receives, or [ack].'
    );
    expect(prompt.match(/<lane-instructions /g)).toHaveLength(1);
  });

  it('shows a replayed delta its lane text unchanged and states that nothing is delivered', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () =>
        [
          {
            id: 'delta-with-markers',
            kind: 'workflow',
            topic: 'lane/source-delta',
            summary: 'Handle the change.',
            applies_when: 'For deltas',
            steps: ['Send [ack] for chatter and record nothing.'],
            status: 'active',
            updated_at: 1,
          },
        ] as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'replay_delta', 'replay-lane-text', false);
    expect(prompt).toContain('Send [ack] for chatter and record nothing.');
    expect(prompt).toContain(
      'This replay window is history and is not delivered to the owner: notification instructions do not apply, and the turn ends without [notify] or [ack].'
    );
    expect(prompt).not.toContain('End this turn with exactly one marker');
  });

  it('gives owner-answer turns no delta marker contract', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => [],
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'owner_message', 'owner-no-markers', false);
    expect(prompt).toContain('<lane-instructions lane="owner-answer">');
    expect(prompt).not.toContain('[notify]');
    expect(prompt).not.toContain('[ack]');
  });

  it('projects lane action names to the Claude tool names and gives no change instruction', async () => {
    const delivery = createStimulusDelivery({
      backend: 'claude',
      guidanceResolver: async () => [],
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'source_delta', 'claude-lane-actions', false);
    expect(prompt).toContain('mcp__mama__report_publish');
    expect(prompt).not.toContain('report.publish');
    // Turn content never tells the agent to save a lane; the standing correction rule does.
    expect(prompt).not.toContain('memory_save');
  });

  it('omits topic-page work from delta defaults when the wiki is disabled', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => [],
      timeZone: createTimeZoneSetting('UTC'),
      wikiEnabled: false,
    } as never);

    const prompt = await deliver(delivery, 'source_delta', 'delta-no-wiki', false);
    expect(prompt).not.toContain('manage.wiki.');
    expect(prompt).not.toContain('topic wiki page');
    expect(prompt).toContain('end_of_window_instructions');
  });

  it('shows a lane record unchanged and states the wiki is off when it is disabled', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () =>
        [
          {
            id: 'delta-with-wiki-step',
            kind: 'workflow',
            topic: 'lane/source-delta',
            summary: 'Handle the change.',
            applies_when: 'For deltas',
            steps: ['Never touch the topic wiki page.'],
            status: 'active',
            updated_at: 1,
          },
        ] as never,
      timeZone: createTimeZoneSetting('UTC'),
      wikiEnabled: false,
    } as never);

    const prompt = await deliver(delivery, 'source_delta', 'delta-record-no-wiki', false);
    expect(prompt).toContain('Never touch the topic wiki page.');
    expect(prompt).toContain('wiki: disabled; skip any wiki step in these corrections.');
  });
});
