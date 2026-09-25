import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner runtime assembly', () => {
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
