import { describe, expect, it, vi } from 'vitest';
import {
  buildWindowQueue,
  trelloCardsFromEvents,
  WindowQueueIncompleteError,
  type QueueEmbedder,
  type QueueJev,
  type ReplayQueueEvent,
} from '../../src/replay/window-queue.js';

const startMs = Date.parse('2026-09-02T00:00:00.000+09:00');

function event(index: number, overrides: Partial<ReplayQueueEvent> = {}): ReplayQueueEvent {
  return {
    connector: 'source',
    sourceId: `source-${index}`,
    observationRef: `observation-${index}`,
    channelKey: 'channel',
    channelName: 'channel',
    sourceAtMs: startMs + index * 60_000,
    rawRowId: index,
    author: 'actor',
    contentPreview: `line-${index}`,
    metadata: { threadTs: `thread-${index}` },
    ...overrides,
  };
}

const vocabulary = {
  // The owner's domain notes (vocabulary.notes); question wording lives in the pipeline.
  notes: {
    pairs: 'consecutive message pairs from work channels',
    chunk: 'a contiguous chunk of messages from one channel',
    cards: 'facts about the candidate work items',
    dup: 'work items recorded by the owner agent',
  },
};

function injectedJev(): QueueJev {
  return {
    ask: vi.fn(async (request) => {
      const state = request.state as { chunkIndex?: number; candidates?: unknown[] };
      const answers: Record<string, Record<string, unknown>> = {};
      for (const key of Object.keys(request.questions)) {
        if (key === 'relevance') {
          answers[key] = { noul: state.chunkIndex === 3 ? 0.2 : 0.9 };
        } else if (key.startsWith('candidate-')) {
          const candidateIndex = Number(key.slice('candidate-'.length));
          const score =
            state.chunkIndex === 0 && candidateIndex === 0
              ? 0.9
              : state.chunkIndex === 1 && candidateIndex === 0
                ? 0.6
                : 0.2;
          answers[key] = { noul: score };
        } else if (/^d\d+$/.test(key)) {
          answers[key] = { noul: 0.7 };
        } else if (/^p\d+$/.test(key)) {
          answers[key] = { noul: 0.9 };
        }
      }
      return answers;
    }),
  };
}

const embedder: QueueEmbedder = {
  embed: vi.fn(async (text) => new Float32Array([text.length, 1])),
};

describe('day-window queue', () => {
  it('keeps every source line and emits A, B, C, unresolved, and duplicate material', async () => {
    const queue = await buildWindowQueue({
      startMs,
      endMs: startMs + 24 * 60 * 60 * 1_000,
      events: [event(0), event(1), event(2), event(3)],
      workItems: [
        { commitmentId: 'commitment-1', title: 'item-one', stage: 'stage-one', status: 'pending' },
        { commitmentId: 'commitment-2', title: 'item-two', stage: 'stage-two', status: 'done' },
      ],
      trelloCards: [
        {
          cardId: 'card-1',
          name: 'card-one',
          firstActivityMs: startMs,
          lastActivityMs: startMs,
          list: 'state-one',
          listHistory: ['state-one'],
        },
      ],
      vocabulary,
      jev: injectedJev(),
      embedder,
      topK: 1,
    });

    expect(queue.sections.a).toHaveLength(1);
    expect(queue.sections.b).toHaveLength(1);
    expect(queue.sections.c).toHaveLength(1);
    expect(queue.sections.unresolved).toHaveLength(1);
    expect(queue.sections.suspectedDuplicates).toHaveLength(1);
    expect(queue.sections.a[0]?.lines[0]).toMatchObject({
      observationRef: 'observation-0',
      channelName: 'channel',
      author: 'actor',
      text: 'line-0',
    });
    expect(queue.sections.unresolved[0]?.lines[0]?.text).toBe('line-3');
  });

  it('uses source identity for deduplication and never drops a short line', async () => {
    const queue = await buildWindowQueue({
      startMs,
      endMs: startMs + 24 * 60 * 60 * 1_000,
      events: [event(0, { contentPreview: 'x' }), event(0, { contentPreview: 'different text' })],
      workItems: [],
      trelloCards: [],
      vocabulary,
      jev: injectedJev(),
      embedder,
    });

    expect(queue.lines).toHaveLength(1);
    expect(queue.lines[0]?.text).toBe('x');
  });

  it('asks Jev whether adjacent unthreaded lines belong together', async () => {
    const ask = vi.fn(async (request) => {
      const answers: Record<string, Record<string, unknown>> = {};
      for (const key of Object.keys(request.questions)) {
        answers[key] = /^p\d+$/.test(key) ? { noul: 0.2 } : { noul: 0.9 };
      }
      return answers;
    });

    const queue = await buildWindowQueue({
      startMs,
      endMs: startMs + 24 * 60 * 60 * 1_000,
      events: [
        event(0, { metadata: undefined }),
        event(1, { metadata: undefined, sourceAtMs: startMs + 60_000 }),
      ],
      workItems: [],
      trelloCards: [],
      vocabulary,
      jev: { ask },
      embedder,
    });

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ questions: { p0: expect.any(Object) } })
    );
    expect(queue.sections.c).toHaveLength(2);
  });

  it('stops the window when a Jev verdict is absent and names the affected observations', async () => {
    const jev: QueueJev = {
      ask: vi.fn(async () => ({})),
    };

    await expect(
      buildWindowQueue({
        startMs,
        endMs: startMs + 24 * 60 * 60 * 1_000,
        events: [event(0)],
        workItems: [],
        trelloCards: [],
        vocabulary,
        jev,
        embedder,
      })
    ).rejects.toMatchObject({
      name: 'WindowQueueIncompleteError',
      observationRefs: ['observation-0'],
    } satisfies Partial<WindowQueueIncompleteError>);
  });

  it('names the candidate in each candidate question and carries the owner notes as context', async () => {
    const jev = injectedJev();
    await buildWindowQueue({
      startMs,
      endMs: startMs + 24 * 60 * 60 * 1_000,
      events: [event(0, { metadata: undefined })],
      workItems: [
        { commitmentId: 'work-a', title: 'first item', stage: null, status: 'pending' },
        { commitmentId: 'work-b', title: 'second item', stage: null, status: 'pending' },
      ],
      trelloCards: [],
      vocabulary,
      jev,
      embedder,
    });
    const classify = (jev.ask as ReturnType<typeof vi.fn>).mock.calls
      .map(
        (call) =>
          call[0] as {
            questions: Record<string, { instructions: string }>;
            state: { note?: string };
          }
      )
      .find((request) => 'relevance' in request.questions)!;
    const instructions = Object.entries(classify.questions)
      .filter(([key]) => key.startsWith('candidate-'))
      .map(([, question]) => question.instructions);
    expect(instructions).toHaveLength(2);
    expect(new Set(instructions).size).toBe(2);
    expect(instructions.join(' ')).toContain('work:work-a');
    expect(classify.state.note).toContain(vocabulary.notes.chunk);
  });

  it('reads Trello card facts from the imported action shape (data.card, listAfter)', () => {
    const cards = trelloCardsFromEvents([
      event(0, {
        connector: 'trello',
        metadata: {
          cardId: 'card-1',
          data: { card: { name: 'card name' }, list: { name: 'waiting' } },
        },
      }),
      event(1, {
        connector: 'trello',
        metadata: {
          cardId: 'card-1',
          data: {
            card: { name: 'card name' },
            listBefore: { name: 'waiting' },
            listAfter: { name: 'submitted' },
          },
        },
      }),
    ]);
    expect(cards).toEqual([
      expect.objectContaining({
        cardId: 'card-1',
        name: 'card name',
        list: 'submitted',
        listHistory: ['waiting', 'submitted'],
      }),
    ]);
  });

  it('lists only the duplicate pairs Jev scores as suspected, without window refs', async () => {
    const jev: QueueJev = {
      ask: vi.fn(async (request) => {
        const answers: Record<string, Record<string, unknown>> = {};
        for (const key of Object.keys(request.questions)) {
          answers[key] = { noul: /^d\d+$/.test(key) ? (key === 'd0' ? 0.9 : 0.1) : 0.9 };
        }
        return answers;
      }),
    };
    const queue = await buildWindowQueue({
      startMs,
      endMs: startMs + 24 * 60 * 60 * 1_000,
      events: [event(0, { metadata: undefined })],
      workItems: ['a', 'b', 'c', 'd'].map((id) => ({
        commitmentId: `work-${id}`,
        title: `item ${id}`,
        stage: null,
        status: 'pending',
      })),
      trelloCards: [],
      vocabulary,
      jev,
      embedder,
    });
    expect(queue.sections.suspectedDuplicates).toHaveLength(1);
    expect(queue.sections.suspectedDuplicates[0]).not.toHaveProperty('observationRefs');
  });
});
