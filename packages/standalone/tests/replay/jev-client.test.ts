import { describe, expect, it, vi } from 'vitest';
import {
  createJevClient,
  JevBatchIncompleteError,
  type JevBatchRequest,
} from '../../src/replay/jev-client.js';

const request: JevBatchRequest = {
  state: { refs: ['observation-1'] },
  questions: { q1: { type: 'noul', instructions: 'classify this line' } },
  observationRefs: ['observation-1'],
};

function client(fetchImpl: typeof fetch, sleep = vi.fn(async () => {})) {
  return createJevClient({
    keyFile: '/synthetic/key',
    vocabFile: '/synthetic/vocab',
    endpoint: 'https://example.invalid/jev',
    fetch: fetchImpl,
    readKey: () => 'injected',
    readVocab: () => ({ notes: { relevance: 'classify the line' } }),
    sleep,
  });
}

describe('Jev client', () => {
  it('posts only model, state and questions (the API rejects other fields) and returns answers', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // Live 2026-09-25: a body with the owner vocabulary as `vocab` was rejected (HTTP 400).
      expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(init?.headers).toHaveProperty('Authorization');
      return new Response(JSON.stringify({ answers: { q1: { noul: 0.9 } } }), { status: 200 });
    });

    await expect(client(fetchImpl).ask(request)).resolves.toEqual({ q1: { noul: 0.9 } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('names the provider error type and request id when retries run out', async () => {
    const body = JSON.stringify({ detail: { error_type: 'internal_error', request_id: 'req_1' } });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 500 }));
    await expect(client(fetchImpl).ask(request)).rejects.toThrow(/internal_error, req_1/);
  });

  it('retries a transient 500 before accepting a later success', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ answers: { q1: { noul: 0.4 } } }), { status: 200 })
      );
    await expect(client(fetchImpl).ask(request)).resolves.toEqual({ q1: { noul: 0.4 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries 429 and 529 before accepting a later success', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response('busy', { status: 529 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ answers: { q1: { noul: 0.5 } } }), { status: 200 })
      );
    const sleep = vi.fn(async () => {});

    await expect(client(fetchImpl, sleep).ask(request)).resolves.toEqual({ q1: { noul: 0.5 } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('stops a failed batch and names every observation ref in the incomplete error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('failed', { status: 500 }));
    const batch = {
      ...request,
      observationRefs: ['observation-1', 'observation-2'],
    };

    await expect(client(fetchImpl).askBatch([batch])).rejects.toMatchObject({
      name: 'JevBatchIncompleteError',
      observationRefs: ['observation-1', 'observation-2'],
    } satisfies Partial<JevBatchIncompleteError>);
  });
});
