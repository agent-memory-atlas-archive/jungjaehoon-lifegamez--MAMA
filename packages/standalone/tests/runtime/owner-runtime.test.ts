import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { createOwnerPolicyProvider } from '../../src/runtime/owner-policy.js';
import { createClient } from '@jungjaehoon/mama-core/client/client';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner runtime assembly', () => {
  it('routes authenticated Claude socket caller facts to the active native session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'caller-socket-'));
    homes.push(home);
    const callAction = vi.fn(async () => ({ status: 'completed' as const, data: { ok: true } }));
    const owner = await createOwnerRuntime({
      backend: 'claude',
      model: 'fixture-model',
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [],
      nativeSession: { stop: async () => {}, callAction },
      maxTurns: 10,
      timeout: 1_000,
    });
    try {
      const client = createClient({
        socketPath: join(home, 'runtime.sock'),
        journalPath: join(home, 'journal.jsonl'),
        credential: readFileSync(join(home, 'credential'), 'utf8').trim(),
      });
      const caller = { session_id: 'session', tool_use_id: 'call', agent_id: 'child' };
      expect(
        await client.call({
          action: 'work.create',
          input: { topic: 'fixture' },
          operationId: 'op-fixture',
          session: { nativeCaller: caller },
        })
      ).toMatchObject({ status: 'completed' });
      expect(callAction).toHaveBeenCalledWith(
        { action: 'work.create', input: { topic: 'fixture' }, operationId: 'op-fixture' },
        caller
      );
    } finally {
      await owner.stop();
    }
  });
  it('reloads an external owner policy and fingerprints exact file bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-policy-'));
    homes.push(home);
    const provider = createOwnerPolicyProvider(home);

    expect(provider()).toMatchObject({ content: null, loaded: false });

    writeFileSync(join(home, 'owner-policy.md'), 'title format: owner policy\n', 'utf8');
    const first = provider();
    writeFileSync(join(home, 'owner-policy.md'), 'title format: updated policy\n', 'utf8');
    const second = provider();

    expect(first).toMatchObject({ content: 'title format: owner policy\n', loaded: true });
    expect(second).toMatchObject({ content: 'title format: updated policy\n', loaded: true });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('passes the embedder into real knowledge so work.create stores a vector', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-runtime-'));
    homes.push(home);
    const nativeSession: NativeSessionHandle = { stop: async () => {} };
    const embed = vi.fn(async () => new Float32Array(1024).fill(0.25));
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'test-model',
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [{ kind: 'project', id: 'scope' }],
      embedder: { embed },
      nativeSession,
      maxTurns: 20,
      timeout: 1_000,
    });
    try {
      const result = await owner.surface.hostToolCall(
        'work.create',
        {
          topic: 'topic',
          summary: 'summary',
          set: { title: 'work' },
        },
        'operation-1'
      );
      expect(result.status).toBe('completed');
      expect(embed).toHaveBeenCalled();
      expect(
        owner.database.adapter.prepare('SELECT COUNT(*) AS count FROM embeddings').get()
      ).toEqual({ count: 1 });
    } finally {
      await owner.stop();
    }
  });

  it('lets the owner save a correction under user and connector channel scopes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-memory-scope-'));
    homes.push(home);
    const nativeSession: NativeSessionHandle = { stop: async () => {} };
    const embed = vi.fn(async () => new Float32Array(1024).fill(0.25));
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'test-model',
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [{ kind: 'global', id: 'system' }],
      embedder: { embed },
      nativeSession,
      maxTurns: 20,
      timeout: 1_000,
    });
    try {
      const result = await owner.surface.hostToolCall(
        'memory.save',
        {
          topic: 'owner-correction',
          kind: 'lesson',
          summary: 'The owner correction is durable',
          details: 'The correction was linked to the source evidence.',
          scopes: [
            { kind: 'user', id: 'owner' },
            { kind: 'channel', id: 'chatwork' },
          ],
          source: { package: 'standalone', source_type: 'owner-correction' },
        },
        'operation-memory-scope'
      );
      expect(result.status).toBe('completed');
    } finally {
      await owner.stop();
    }
  });
});
