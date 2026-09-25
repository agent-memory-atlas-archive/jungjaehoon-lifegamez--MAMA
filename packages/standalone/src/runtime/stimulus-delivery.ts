import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '@jungjaehoon/mama-core/canonicalize';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { ContentBlock } from '@jungjaehoon/mama-core/runtime/drivers/types';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import type {
  RuntimeHandle,
  StimulusDelivery,
  StimulusReceipt,
} from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { SourceDelta } from '../connectors/framework/polling-scheduler.js';

export const OWNER_RUNTIME_SESSION_KEY = 'owner:runtime';

export interface OwnerMessageInput {
  id: string;
  channelKey: string;
  occurredAt: number;
  text: string;
  replyTo?: string | null;
  payload?: JsonValue;
}

export interface ScheduledInput {
  id: string;
  channelKey: string;
  occurredAt: number;
  payload?: JsonValue;
}

export interface NativeEventInput {
  id: string;
  channelKey: string;
  occurredAt: number;
  payload?: JsonValue;
}

export interface StimulusIntake {
  accept(stimulus: Stimulus): StimulusReceipt;
  isPending?(sourceMessageRef: string): boolean;
  acceptOwnerMessage(input: OwnerMessageInput): StimulusReceipt;
  acceptSourceDelta(delta: SourceDelta): StimulusReceipt;
  acceptScheduled(input: ScheduledInput): StimulusReceipt;
  acceptNativeEvent(input: NativeEventInput): StimulusReceipt;
}

export interface StimulusDeliveryOptions {
  onOwnerResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onSourceResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onScheduledNoop?: (row: MailboxRow) => void | Promise<void>;
  onNativeEventResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onDelivered?: (row: MailboxRow) => void | Promise<void>;
  onFailed?: (row: MailboxRow, error: unknown) => void | Promise<void>;
}

function sourceObservationHandle(ref: SourceDelta['refs'][number]): string {
  if (typeof ref.observationRef !== 'string' || ref.observationRef.trim() === '') {
    throw new Error(`Source delta ref ${ref.connector}:${ref.sourceId} has no observationRef`);
  }
  return ref.observationRef;
}

function sourceRefId(ref: SourceDelta['refs'][number]): string {
  return `${ref.connector}:${sourceObservationHandle(ref)}`;
}

export function sourceDeltaStimulusId(delta: SourceDelta): string {
  if (delta.refs.length === 0)
    throw new Error('A source delta requires at least one observation ref');
  const refs = delta.refs.map((ref) => sourceRefId(ref)).sort();
  const digest = createHash('sha256')
    .update(canonicalizeJSON({ coalesceKey: delta.coalesceKey, refs }))
    .digest('hex');
  return `source_delta:${digest}`;
}

function sourcePayload(delta: SourceDelta): JsonValue {
  return {
    kind: delta.kind,
    collector: delta.collector,
    channel: delta.channel,
    coalesceKey: delta.coalesceKey,
    refs: delta.refs.map((ref) => ({
      connector: ref.connector,
      observationRef: sourceObservationHandle(ref),
      sourceId: ref.sourceId,
      sourceEntityId: ref.sourceEntityId,
      sourceAt: ref.sourceAt,
      observedAt: ref.observedAt,
      contentHash: ref.contentHash,
      ...(ref.metadata === undefined ? {} : { metadata: ref.metadata }),
    })),
    preview: [...delta.preview],
  } as unknown as JsonValue;
}

export function createStimulusIntake(
  runtime: Pick<RuntimeHandle, 'accept' | 'mailbox'>,
  principalId: string
): StimulusIntake {
  const ownerPayload = (input: OwnerMessageInput): JsonValue =>
    input.payload === undefined ? { text: input.text } : { text: input.text, input: input.payload };
  return {
    accept: (stimulus) => runtime.accept({ ...stimulus, principalId }),
    isPending: (sourceMessageRef) => {
      const row = runtime.mailbox?.readInput(sourceMessageRef, principalId);
      return row?.status === 'pending' || row?.status === 'claimed';
    },
    acceptOwnerMessage: (input) =>
      runtime.accept({
        id: input.id,
        kind: 'owner_message',
        principalId,
        channelKey: input.channelKey,
        occurredAt: input.occurredAt,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        payload: ownerPayload(input),
      }),
    acceptSourceDelta: (delta) =>
      runtime.accept({
        id: sourceDeltaStimulusId(delta),
        kind: 'source_delta',
        principalId,
        channelKey: delta.channel,
        refs: delta.refs.map((ref) => ({
          refId: sourceRefId(ref),
          observationRef: sourceObservationHandle(ref),
        })),
        preview: [...delta.preview],
        coalesceKey: delta.coalesceKey,
        occurredAt: Math.max(...delta.refs.map((ref) => Date.parse(ref.observedAt))),
        payload: sourcePayload(delta),
      }),
    acceptScheduled: (input) =>
      runtime.accept({
        id: input.id,
        kind: 'scheduled',
        principalId,
        channelKey: input.channelKey,
        occurredAt: input.occurredAt,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      }),
    acceptNativeEvent: (input) =>
      runtime.accept({
        id: input.id,
        kind: 'native_event',
        principalId,
        channelKey: input.channelKey,
        occurredAt: input.occurredAt,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      }),
  };
}

function boundedStimulus(row: MailboxRow): string {
  const lines = [
    '## Bounded stimulus',
    `kind: ${row.kind ?? 'unknown'}`,
    `stimulus_id: ${row.stimulusId}`,
    `channel: ${row.channelKey}`,
    `occurred_at: ${new Date(row.occurredAt).toISOString()}`,
    `preview: ${JSON.stringify(row.preview)}`,
    `refs: ${JSON.stringify(row.refs)}`,
  ];
  if (row.payload !== undefined) lines.push(`payload: ${JSON.stringify(row.payload)}`);
  return lines.join('\n');
}

/** The turn carries only the stimulus; the standing text is the session's system prompt. */
function assembledContent(row: MailboxRow): ContentBlock[] {
  return [{ type: 'text', text: boundedStimulus(row) }];
}

/** Deliver every model-bearing kind through one serialized owner session. */
export function createStimulusDelivery(options: StimulusDeliveryOptions): StimulusDelivery {
  let serialTail = Promise.resolve();

  const deliver: StimulusDelivery['deliver'] = async (row, context) => {
    let release!: () => void;
    const previous = serialTail;
    serialTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (row.kind === 'scheduled') {
        await options.onScheduledNoop?.(row);
      } else {
        if (
          row.kind !== 'owner_message' &&
          row.kind !== 'source_delta' &&
          row.kind !== 'native_event'
        ) {
          throw new Error('Stimulus kind is missing; no owner turn can be assembled');
        }
        const result = await context.run(assembledContent(row), {
          sessionKey: OWNER_RUNTIME_SESSION_KEY,
          source: row.kind,
          channelId: row.channelKey,
          sourceMessageRef: row.stimulusId,
        });
        if (row.kind === 'owner_message') await options.onOwnerResult?.(row, result);
        if (row.kind === 'source_delta') await options.onSourceResult?.(row, result);
        if (row.kind === 'native_event') await options.onNativeEventResult?.(row, result);
      }
      await options.onDelivered?.(row);
    } catch (error) {
      await options.onFailed?.(row, error);
      throw error;
    } finally {
      release();
    }
  };

  return { deliver, prefer: ['owner_message'] };
}
