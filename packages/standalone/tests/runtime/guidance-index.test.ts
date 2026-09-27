import { describe, expect, it, vi } from 'vitest';
import type { NativeInvocationOptions } from '@jungjaehoon/mama-core/runtime/runtime';
import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

function row(kind: string, id: string) {
  return {
    id,
    stimulusId: id,
    principalId: 'owner',
    kind,
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
          ? { report: 'full', hourKey: '2026-09-27:15' }
          : { text: `${kind} stimulus` },
    coalesceKey: null,
  };
}

async function deliver(
  delivery: ReturnType<typeof createStimulusDelivery>,
  kind: string,
  id: string,
  isNewSession: boolean,
  failAfterPreparation = false
): Promise<string> {
  let prompt = '';
  await delivery.deliver(
    row(kind, id) as never,
    {
      nativeInputId: id,
      resultForReceipt: () => null,
      run: async (content, request?: NativeInvocationOptions) => {
        const prepared = await request?.prepareSessionContent?.({
          sessionId: 'owner-session',
          isNewSession,
        } as never);
        prompt = (prepared ?? content).map((block) => block.text ?? '').join('\n');
        if (failAfterPreparation) throw new Error('model turn did not complete');
        return {} as never;
      },
      steer: vi.fn(),
      wasDispatched: () => false,
      onInputDispatch: vi.fn(),
      onAccepted: vi.fn(),
    } as never
  );
  return prompt;
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
});
