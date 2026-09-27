/**
 * The runtime owns the intake, and a stimulus enters by one door.
 *
 * v7 §4.3: `runtime.start` alone opens the DB, native session, model and socket
 * — one start subject per profile. A product that constructs its own intake beside the
 * runtime has two openers of one table and no single place that says when it
 * exists.
 *
 * What `accept` does is exactly two things: prove the stated principal is one
 * this runtime serves, and make the stimulus durable. What it must NOT do is
 * decide what the stimulus means — no classification, no work row, no outcome
 * on the receipt. §4.4: a delivery ACK is not a work receipt, and this receipt
 * is one step earlier than that.
 */
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import type { JudgmentAccess } from '../../src/knowledge/judgments.js';
import {
  startRuntime,
  type RuntimeHandle,
  type StimulusDelivery,
} from '../../src/runtime/runtime.js';
import type { Stimulus } from '../../src/runtime/mailbox.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

const OWNER: JudgmentAccess = {
  principalId: 'principal-owner',
  agentId: 'agent-owner',
  scopes: [{ kind: 'project', id: 'scope-shared' }],
  actions: [],
};

const started: RuntimeHandle[] = [];
const dirs: string[] = [];
const adapters: DatabaseAdapter[] = [];

async function boot(
  options: {
    withMailbox?: boolean;
    delivery?: StimulusDelivery;
    extraPrincipal?: JudgmentAccess;
  } = {}
): Promise<RuntimeHandle> {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'mama-intake-'));
  dirs.push(dir);
  const catalog = createCatalog([]);
  let mailbox: { adapter: DatabaseAdapter } | undefined;
  if (options.withMailbox !== false) {
    const adapter = new NodeSQLiteAdapter({
      dbPath: join(dir, 'core.db'),
    }) as unknown as DatabaseAdapter;
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    adapters.push(adapter);
    mailbox = { adapter };
  }
  const runtime = await startRuntime({
    paths: { socketPath: join(dir, 'runtime.sock') },
    catalog,
    dispatch: createDispatcher(catalog),
    principals: [
      { access: OWNER, credentialPath: join(dir, 'owner.credential') },
      ...(options.extraPrincipal
        ? [{ access: options.extraPrincipal, credentialPath: join(dir, 'other.credential') }]
        : []),
    ],
    reclaimStaleSocket: true,
    ...(mailbox ? { mailbox } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
  });
  started.push(runtime);
  return runtime;
}

afterEach(async () => {
  for (const runtime of started.splice(0)) {
    await runtime.stop().catch(() => {});
  }
  for (const adapter of adapters.splice(0)) {
    try {
      adapter.close();
    } catch {
      // best effort
    }
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const stimulus = (over: Partial<Stimulus> = {}): Stimulus => ({
  id: `stim-${randomUUID()}`,
  kind: 'owner_message',
  principalId: OWNER.principalId,
  channelKey: 'telegram:owner-chat',
  occurredAt: 1_000,
  ...over,
});

describe('startRuntime opens the intake it owns', () => {
  it('keeps a second served principal out of the owner input view', async () => {
    const publicAccess: JudgmentAccess = {
      principalId: 'principal-public',
      agentId: 'agent-public',
      scopes: [],
      actions: [],
    };
    const runtime = await boot({ extraPrincipal: publicAccess });
    expect(runtime.servesPrincipal(publicAccess.principalId)).toBe(true);
    expect(runtime.servesPrincipal('unknown')).toBe(false);
    runtime.accept(stimulus({ id: 'public-message', principalId: publicAccess.principalId }));
    expect(runtime.mailbox!.principalsForInput('public-message')).toEqual([
      publicAccess.principalId,
    ]);
    expect(runtime.mailbox!.readInput('public-message', OWNER.principalId)).toBeNull();
    expect(runtime.mailbox!.readInput('public-message', publicAccess.principalId)).toMatchObject({
      principalId: publicAccess.principalId,
    });
  });

  it('the mailbox the runtime opened is the one the drain reads', async () => {
    const runtime = await boot();
    expect(runtime.mailbox).toBeDefined();
    const receipt = runtime.accept(stimulus({ preview: ['hello'] }));
    expect(receipt.state).toBe('accepted');

    const claimed = runtime.mailbox!.claimNext();
    expect(claimed?.id).toBe(Number(receipt.inputId));
    expect(claimed?.preview).toEqual(['hello']);
  });

  it('the intake outlives nothing it did not open: stop closes the socket, not the store', async () => {
    const runtime = await boot();
    runtime.accept(stimulus());
    await runtime.stop();
    started.length = 0;
    // The store is the product's; a durable stimulus is still there to drain.
    expect(runtime.mailbox!.depth().pending).toBe(1);
  });
});

describe('stop closes what start opened, in an order that makes each close safe', () => {
  it('releases the harness before the socket the harness is still calling', async () => {
    const order: string[] = [];
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'mama-intake-stop-'));
    dirs.push(dir);
    const catalog = createCatalog([]);
    const runtime = await startRuntime({
      paths: { socketPath: join(dir, 'runtime.sock') },
      catalog,
      dispatch: createDispatcher(catalog),
      principals: [{ access: OWNER, credentialPath: join(dir, 'owner.credential') }],
      reclaimStaleSocket: true,
      nativeSession: {
        stop: async () => {
          // A turn still running holds action calls; the socket must outlive it.
          order.push('harness');
          expect(fs.existsSync(join(dir, 'runtime.sock'))).toBe(true);
        },
      },
    });
    expect(runtime.nativeSession).toBeDefined();

    await runtime.stop();
    order.push('socket');

    expect(order).toEqual(['harness', 'socket']);
    expect(fs.existsSync(join(dir, 'owner.credential'))).toBe(false);
  });

  it('a runtime that opened no harness does not pretend to close one', async () => {
    const runtime = await boot();
    expect(runtime.nativeSession).toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
    started.length = 0;
  });
});

describe('accept is the one door, and it refuses loudly', () => {
  it('refuses a principal this runtime does not serve', async () => {
    const runtime = await boot();
    expect(() => runtime.accept(stimulus({ principalId: 'principal-stranger' }))).toThrow(
      /not served here/
    );
    expect(runtime.mailbox!.depth().pending).toBe(0);
  });

  it('refuses a kind no producer may state', async () => {
    const runtime = await boot();
    expect(() => runtime.accept(stimulus({ kind: 'report' as never }))).toThrow(
      /unknown stimulus kind/
    );
  });

  it('refuses a stimulus with no channel identity', async () => {
    const runtime = await boot();
    expect(() => runtime.accept(stimulus({ channelKey: '  ' }))).toThrow(/channel identity/);
  });

  it('refuses when the runtime opened no intake, rather than dropping it quietly', async () => {
    const runtime = await boot({ withMailbox: false });
    expect(runtime.mailbox).toBeUndefined();
    expect(() => runtime.accept(stimulus())).toThrow(/requires a mailbox store/);
  });
});

describe('the receipt says acceptance and nothing more', () => {
  it('carries no outcome, classification or work status', async () => {
    const runtime = await boot();
    const receipt = runtime.accept(stimulus());
    expect(Object.keys(receipt).sort()).toEqual(['inputId', 'state']);
    expect(receipt.state).toBe('accepted');
  });

  it('a redelivered stimulus is a duplicate, and nothing is lost', async () => {
    const runtime = await boot();
    const one = stimulus({ id: 'same', refs: [{ refId: 'e1', observationRef: 'obs-1' }] });
    expect(runtime.accept(one).state).toBe('accepted');
    const again = runtime.accept({ ...one, preview: ['re-sent'] });
    expect(again).toEqual({ inputId: null, state: 'duplicate' });
    expect(runtime.mailbox!.depth().pending).toBe(1);
  });

  it('all three v7 kinds enter the same door', async () => {
    const runtime = await boot();
    for (const kind of ['owner_message', 'source_delta', 'scheduled'] as const) {
      expect(runtime.accept(stimulus({ kind })).state).toBe('accepted');
    }
    const kinds = [
      runtime.mailbox!.claimNext()?.kind,
      runtime.mailbox!.claimNext()?.kind,
      runtime.mailbox!.claimNext()?.kind,
    ];
    expect(kinds).toEqual(['owner_message', 'source_delta', 'scheduled']);
  });
});

describe('the runtime carries what it accepted through to the loop', () => {
  it('delivers on accept, acks what the loop took, and leaves nothing pending', async () => {
    const taken: string[] = [];
    const runtime = await boot({
      delivery: {
        deliver: async (row) => {
          taken.push(row.stimulusId);
        },
        intervalMs: 0,
      },
    });
    runtime.accept(stimulus({ id: 'one' }));
    runtime.accept(stimulus({ id: 'two' }));
    await runtime.drainOnce();

    expect(taken).toEqual(['one', 'two']);
    expect(runtime.mailbox!.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
  });

  it('a delivery that throws is owed again, not lost and not acked', async () => {
    let attempts = 0;
    const runtime = await boot({
      delivery: {
        deliver: async () => {
          attempts += 1;
          throw new Error('the loop was not there');
        },
        intervalMs: 0,
      },
    });
    runtime.accept(stimulus({ id: 'owed' }));

    const first = await runtime.drainOnce();
    expect(first).toEqual({ delivered: 0, failed: 1, dead: 0 });
    expect(attempts).toBe(1);
    // Back to pending, behind its backoff - still owed, never acked.
    expect(runtime.mailbox!.depth()).toEqual({ pending: 1, claimed: 0, dead: 0 });
  });

  it('the owner’s own message does not wait behind a mass replay', async () => {
    const taken: string[] = [];
    const runtime = await boot({
      delivery: {
        deliver: async (row) => {
          taken.push(row.stimulusId);
        },
        prefer: ['owner_message'],
        maxPerTick: 1,
        intervalMs: 0,
      },
    });
    // A backlog lands first, the person asks second.
    for (let i = 0; i < 5; i += 1) {
      runtime.accept(stimulus({ id: `delta-${i}`, kind: 'source_delta' }));
    }
    runtime.accept(stimulus({ id: 'the-question', kind: 'owner_message' }));

    await runtime.drainOnce();
    expect(taken).toEqual(['the-question']);
  });

  it('repeated drains re-attempt nothing and report no phantom work', async () => {
    // Two costs the drain used to pay on every call: a re-attempt of a row
    // inside its backoff, and a full replay scan with three prunes to look for
    // claims younger than a lease. The first was never possible - the backoff
    // holds the row - and the second is now paced to half a lease, since that
    // is the soonest it can report anything new.
    let attempts = 0;
    const runtime = await boot({
      delivery: {
        deliver: async () => {
          attempts += 1;
          throw new Error('never taken');
        },
        intervalMs: 0,
      },
    });
    runtime.accept(stimulus({ id: 'backed-off' }));

    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await runtime.drainOnce());
    }

    expect(attempts).toBe(1);
    expect(results.slice(1).every((result) => result.failed === 0 && result.dead === 0)).toBe(true);
    // Still owed, behind its backoff - nothing was lost by not re-trying.
    expect(runtime.mailbox!.depth()).toEqual({ pending: 1, claimed: 0, dead: 0 });
  });

  it('a runtime with no delivery keeps what it accepted for whoever drains it', async () => {
    const runtime = await boot();
    runtime.accept(stimulus({ id: 'kept' }));
    expect(await runtime.drainOnce()).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(runtime.mailbox!.depth().pending).toBe(1);
  });

  it('stop ends the drain: nothing is delivered after it', async () => {
    const taken: string[] = [];
    const runtime = await boot({
      delivery: {
        deliver: async (row) => {
          taken.push(row.stimulusId);
        },
        intervalMs: 0,
      },
    });
    await runtime.stop();
    started.length = 0;
    runtime.accept(stimulus({ id: 'after-stop' }));
    await runtime.drainOnce();
    expect(taken).toEqual([]);
    // Accepted and durable all the same: the next boot owes it.
    expect(runtime.mailbox!.depth().pending).toBe(1);
  });
});
