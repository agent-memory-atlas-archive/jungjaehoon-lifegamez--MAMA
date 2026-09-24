/**
 * W1 — the caller is a principal, and the credential is what names it.
 *
 * Two things this pins. The credential a call presents selects which principal
 * the action runs as, so two callers on one socket are two principals rather
 * than one shared authority. And the grant is compared before exec: an action
 * outside the principal's list is denied without the action body running at
 * all, which is what makes the list authority rather than decoration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { createClient } from '../../src/client/client.js';
import type { JudgmentAccess } from '../../src/knowledge/judgments.js';
import { startRuntime, type RuntimeHandle } from '../../src/runtime/runtime.js';

/** Who each exec saw, in call order — the record the assertions read. */
const seen: { action: string; principalId: string }[] = [];

const echo = (name: string) => ({
  contract: {
    name,
    summary: 'test-only: records the principal it ran as',
    inputSchema: { type: 'object', additionalProperties: true } as const,
  },
  exec: async (_input: unknown, context: { access: JudgmentAccess }) => {
    seen.push({ action: name, principalId: context.access.principalId });
    return { ok: true };
  },
});

const OWNER: JudgmentAccess = {
  principalId: 'principal-owner',
  agentId: 'agent-owner',
  scopes: [{ kind: 'project', id: 'scope-shared' }],
  actions: ['test.shared', 'test.owner_only'],
};

const READER: JudgmentAccess = {
  principalId: 'principal-reader',
  agentId: 'agent-reader',
  scopes: [{ kind: 'project', id: 'scope-shared' }],
  actions: ['test.shared'],
};

describe('W1: the credential names the principal, and the grant gates dispatch', () => {
  let dir = '';
  let runtime: RuntimeHandle | undefined;
  let ownerCredential = '';
  let readerCredential = '';
  let socketPath = '';
  let journalPath = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mama-principal-grants-'));
    socketPath = join(dir, 'runtime.sock');
    journalPath = join(dir, 'operations.jsonl');
    const ownerCredentialPath = join(dir, 'owner.credential');
    const readerCredentialPath = join(dir, 'reader.credential');
    const catalog = createCatalog([echo('test.shared'), echo('test.owner_only')]);

    runtime = await startRuntime({
      paths: { socketPath },
      catalog,
      dispatch: createDispatcher(catalog),
      principals: [
        { access: OWNER, credentialPath: ownerCredentialPath },
        { access: READER, credentialPath: readerCredentialPath },
      ],
      reclaimStaleSocket: true,
    });
    ownerCredential = readFileSync(ownerCredentialPath, 'utf8');
    readerCredential = readFileSync(readerCredentialPath, 'utf8');
  });

  afterAll(async () => {
    await runtime?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('two credentials calling one action are two principals', async () => {
    const before = seen.length;
    const owner = createClient({ socketPath, journalPath, credential: ownerCredential });
    const reader = createClient({ socketPath, journalPath, credential: readerCredential });

    const ownerResult = await owner.call({ action: 'test.shared', input: {} });
    const readerResult = await reader.call({ action: 'test.shared', input: {} });

    expect(ownerResult.status).toBe('completed');
    expect(readerResult.status).toBe('completed');
    expect(seen.slice(before).map((entry) => entry.principalId)).toEqual([
      'principal-owner',
      'principal-reader',
    ]);
  });

  it('an action outside the grant is denied and its exec never runs', async () => {
    const before = seen.length;
    const reader = createClient({ socketPath, journalPath, credential: readerCredential });

    const result = await reader.call({ action: 'test.owner_only', input: {} });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('denied');
      expect(result.error.code).toBe('action_not_granted');
    }
    // The gate is before exec, not inside it: nothing was recorded.
    expect(seen.slice(before)).toEqual([]);
  });

  it('the same action the reader was denied still runs for the owner', async () => {
    const before = seen.length;
    const owner = createClient({ socketPath, journalPath, credential: ownerCredential });

    const result = await owner.call({ action: 'test.owner_only', input: {} });

    expect(result.status).toBe('completed');
    expect(seen.slice(before)).toEqual([
      { action: 'test.owner_only', principalId: 'principal-owner' },
    ]);
  });

  it('an unresolved credential never reaches dispatch', async () => {
    const before = seen.length;
    const stranger = createClient({ socketPath, journalPath, credential: 'not-a-credential' });

    const result = await stranger.call({ action: 'test.shared', input: {} });

    expect(result.status).toBe('failed');
    expect(seen.slice(before)).toEqual([]);
  });

  it('two principals may not share one credential file', async () => {
    const shared = join(dir, 'shared.credential');
    await expect(
      startRuntime({
        paths: { socketPath: join(dir, 'second.sock') },
        catalog: createCatalog([echo('test.shared')]),
        dispatch: createDispatcher(createCatalog([echo('test.shared')])),
        principals: [
          { access: OWNER, credentialPath: shared },
          { access: READER, credentialPath: shared },
        ],
      })
    ).rejects.toThrow(/own credential path/);
  });
});
