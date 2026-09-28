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
    expect(first).toContain('<owner-corrections>');
    expect(first).toContain(
      'memory-guidance-1 | lesson | release review | applies when: When a release is ready for review'
    );
    expect(first).toContain('  Review the build before sending it.');
    expect(first).toContain('<recent_owner_exchanges>');
    expect(first).toContain('A recent request');

    const second = await deliver(delivery, 'owner_message', 'second-input', false);
    expect(second).not.toContain('<owner-corrections>');
    expect(second).not.toContain('<owner-corrections-changed>');

    const restarted = await deliver(delivery, 'owner_message', 'third-input', true);
    expect(restarted).toContain('<owner-corrections>');
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
    expect(delta).toContain('<owner-corrections-changed>');
    expect(delta).toContain('memory-guidance-revised');
    expect(delta).toContain('When a release needs a second review');
    expect(delta).toContain('memory-guidance-added | workflow | publish a release');
    expect(delta).toContain('  1. Read the checklist');
    expect(delta).toContain('  3. Send the summary');
    expect(delta).toContain('retired: memory-guidance-retired | constraint | old approval route');
    // A revised correction arrives in full, so the agent never works from a stale copy.
    expect(delta).toContain('revised: memory-guidance-revised');
    expect(delta).toContain('  Review the build before sending it.');

    const unchanged = await deliver(delivery, 'native_event', 'native-input', false);
    expect(unchanged).not.toContain('<owner-corrections-changed>');
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
      expect(prompt).not.toContain('<owner-corrections>');
      expect(prompt).not.toContain('<owner-corrections-changed>');
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
    expect(retry).toContain('<owner-corrections-changed>');
    expect(retry).toContain('added: memory-guidance-pending');
  });

  it('shows every active correction in full, whatever its topic, and nothing retired', async () => {
    const records = [
      {
        id: 'report-style',
        kind: 'workflow',
        topic: 'lane/full-report',
        applies_when: 'When writing a report',
        summary: 'Reports lead with the conclusion.',
        steps: ['Write sections with headings.', 'Leave out greetings and apologies.'],
        status: 'active',
        updated_at: 2,
      },
      {
        id: 'old-style',
        kind: 'preference',
        topic: 'report style',
        summary: 'A withdrawn preference.',
        status: 'superseded',
        updated_at: 1,
      },
    ];
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => records as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const owner = await deliver(delivery, 'owner_message', 'corrections-in-full', true);
    expect(owner).toContain(
      'report-style | workflow | lane/full-report | applies when: When writing a report'
    );
    expect(owner).toContain('  Reports lead with the conclusion.');
    expect(owner).toContain('  1. Write sections with headings.');
    expect(owner).toContain('  2. Leave out greetings and apologies.');
    expect(owner).not.toContain('A withdrawn preference.');
  });

  it('marks a correction replaced by a newer one as replaced, not retired', async () => {
    const records: Array<Record<string, unknown>> = [
      {
        id: 'first-style',
        kind: 'preference',
        topic: 'report style',
        summary: 'Short reports.',
        status: 'active',
        updated_at: 1,
      },
    ];
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => records as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);
    await deliver(delivery, 'owner_message', 'style-first', true);
    records[0] = { ...records[0], status: 'superseded', updated_at: 2 };
    records.push({
      id: 'second-style',
      kind: 'preference',
      topic: 'report style',
      summary: 'Short reports with section headings.',
      status: 'active',
      updated_at: 2,
    });

    const next = await deliver(delivery, 'owner_message', 'style-next', false);
    expect(next).toContain(
      'replaced: first-style | preference | report style | status: superseded'
    );
    expect(next).toContain('added: second-style | preference | report style');
    expect(next).toContain('  Short reports with section headings.');
  });

  it('lists corrections oldest first even when their times are stored differently', async () => {
    const records = [
      {
        id: 'b-newer',
        kind: 'lesson',
        topic: 't',
        summary: 'Newer.',
        status: 'active',
        updated_at: '2026-09-28T10:00:00.000Z',
      },
      {
        id: 'a-older',
        kind: 'lesson',
        topic: 't',
        summary: 'Older.',
        status: 'active',
        updated_at: Date.parse('2026-09-28T09:00:00.000Z'),
      },
      {
        id: 'c-oldest',
        kind: 'lesson',
        topic: 't',
        summary: 'Oldest.',
        status: 'active',
        updated_at: 999_999_999,
      },
    ];
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => records as never,
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'owner_message', 'ordering', true);
    const order = ['Oldest.', 'Older.', 'Newer.'].map((text) => prompt.indexOf(text));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it('marks a live source-delta turn as delivered', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => [],
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'source_delta', 'delta-marker-contract', false);
    expect(prompt).toContain('delivery: live');
  });

  it('tells a replayed delta that nothing is delivered', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => [],
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'replay_delta', 'replay-delta', false);
    expect(prompt).toContain('delivery: replay window, not delivered to the owner');
    expect(prompt).not.toContain('delivery: live');
  });

  it('gives owner-message turns no delta marker contract', async () => {
    const delivery = createStimulusDelivery({
      guidanceResolver: async () => [],
      timeZone: createTimeZoneSetting('UTC'),
    } as never);

    const prompt = await deliver(delivery, 'owner_message', 'owner-no-markers', false);
    expect(prompt).not.toContain('[notify]');
    expect(prompt).not.toContain('[ack]');
  });
});
