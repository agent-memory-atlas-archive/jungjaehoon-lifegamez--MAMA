import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  ACKNOWLEDGED_DELTA_CAP,
  readAcknowledgedSourceDeltas,
} from '../../src/runtime/acknowledged-source-deltas.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acknowledged-deltas-'));
  roots.push(root);
  const database = await openCoreDatabase({ path: join(root, 'state.db') });
  let now = new Date('2026-01-01T08:50:00Z').getTime();
  const mailbox = new Mailbox(database.adapter, () => now);
  const acceptAndAck = (id: string, ackAt: string) => {
    const sourceAt = '2026-01-01T08:42:00.000Z';
    const payload = {
      collector: 'fixture',
      channel: 'internal-key',
      preview: ['A change was submitted'],
      refs: [
        {
          connector: 'fixture',
          channelName: 'Work chat',
          observationRef: `observation-${id}`,
          sourceAt,
          contentPreview: 'A change was submitted',
        },
      ],
    };
    const stimulus: Stimulus = {
      id,
      kind: 'source_delta',
      principalId: 'owner',
      channelKey: 'internal-key',
      refs: [{ refId: id, observationRef: `observation-${id}` }],
      preview: ['A change was submitted'],
      payload,
      occurredAt: Date.parse(sourceAt),
    };
    const inputId = mailbox.enqueue(stimulus);
    const claimed = mailbox.claimNext();
    expect(claimed?.id).toBe(inputId);
    now = new Date(ackAt).getTime();
    mailbox.ack(inputId!);
  };
  return { database, acceptAndAck };
}

describe('acknowledged source delta report input', () => {
  it('reads acknowledged live deltas in the report window with labels, source time, preview and refs', async () => {
    const { database, acceptAndAck } = await fixture();

    acceptAndAck('before-window', '2026-01-01T08:59:00Z');
    acceptAndAck('in-window', '2026-01-01T09:30:00Z');

    expect(
      readAcknowledgedSourceDeltas(
        database.adapter,
        new Date('2026-01-01T09:00:00Z').getTime(),
        new Date('2026-01-01T10:00:00Z').getTime()
      )
    ).toEqual({
      total: 1,
      items: [
        {
          channelLabel: 'Work chat',
          sourceAt: '2026-01-01T08:42:00.000Z',
          preview: 'A change was submitted',
          observationRef: 'observation-in-window',
        },
      ],
    });

    await database.close();
  });

  it('keeps the newest deltas past the cap and lists them oldest first', async () => {
    const { database, acceptAndAck } = await fixture();
    const count = ACKNOWLEDGED_DELTA_CAP + 2;
    for (let index = 0; index < count; index += 1) {
      acceptAndAck(
        `d${index}`,
        new Date(Date.parse('2026-01-01T09:00:00Z') + index * 1000).toISOString()
      );
    }

    const batch = readAcknowledgedSourceDeltas(
      database.adapter,
      new Date('2026-01-01T09:00:00Z').getTime(),
      new Date('2026-01-01T10:00:00Z').getTime()
    );

    expect(batch.total).toBe(count);
    expect(batch.items).toHaveLength(ACKNOWLEDGED_DELTA_CAP);
    expect(batch.items[0]!.observationRef).toBe('observation-d2');
    expect(batch.items.at(-1)!.observationRef).toBe(`observation-d${count - 1}`);

    await database.close();
  });
});
