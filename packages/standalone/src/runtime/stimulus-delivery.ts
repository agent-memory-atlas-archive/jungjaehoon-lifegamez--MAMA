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

export interface ReplayClockDelivery extends StimulusDelivery {
  setReplaySourceEndMs(value: number | undefined): void;
  getReplaySourceEndMs(): number | undefined;
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

function sourceOccurrenceTime(delta: SourceDelta): number {
  const sourceTimes = delta.refs.map((ref) => Date.parse(ref.sourceAt));
  if (sourceTimes.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('A source delta requires timezone-qualified source times');
  }
  if (sourceTimes.length === 0) {
    if (delta.replay === undefined)
      throw new Error('A source delta requires at least one source time');
    const emptyWindowTime = delta.occurredAt ?? delta.replay.windowStartMs;
    if (!Number.isSafeInteger(emptyWindowTime) || emptyWindowTime < 0) {
      throw new Error('An empty replay window requires a valid occurrence time');
    }
    return emptyWindowTime;
  }
  const occurredAt = delta.occurredAt ?? Math.max(...sourceTimes);
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new Error('A source delta occurrence time must be a nonnegative epoch millisecond');
  }
  return occurredAt;
}

export function sourceDeltaStimulusId(delta: SourceDelta): string {
  if (delta.refs.length === 0 && delta.replay === undefined) {
    throw new Error('A source delta requires at least one observation ref');
  }
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
      ...(ref.channel === undefined ? {} : { channel: ref.channel }),
      observationRef: sourceObservationHandle(ref),
      sourceId: ref.sourceId,
      sourceEntityId: ref.sourceEntityId,
      sourceAt: ref.sourceAt,
      observedAt: ref.observedAt,
      contentHash: ref.contentHash,
      ...(ref.author === undefined ? {} : { author: ref.author }),
      ...(ref.contentPreview === undefined ? {} : { contentPreview: ref.contentPreview }),
      ...(ref.metadata === undefined ? {} : { metadata: ref.metadata }),
    })),
    preview: [...delta.preview],
    ...(delta.replay === undefined ? {} : { replay: delta.replay }),
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
        occurredAt: sourceOccurrenceTime(delta),
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

function payloadCarriesMessageText(payload: MailboxRow['payload']): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const refs = payload.refs;
  return (
    Array.isArray(refs) &&
    refs.some(
      (ref) =>
        ref !== null && typeof ref === 'object' && !Array.isArray(ref) && 'contentPreview' in ref
    )
  );
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`A message line needs a source time, got ${iso}`);
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(5, 16).replace('T', ' ');
}

function textField(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A source delta whose refs carry message text is rendered as one line per message.
 * The session keeps every turn, so ids, hashes and connector metadata would be re-read on
 * each later model call; the stored observation stays one source.read away.
 */
function messageLines(payload: JsonValue | undefined): string[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const refs = payload.refs;
  if (!Array.isArray(refs) || !payloadCarriesMessageText(payload)) return null;
  const lines: string[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const author = textField(ref.author) || 'unknown';
    const text = textField(ref.contentPreview).replace(/\s+/g, ' ').trim();
    lines.push(
      `[${kstStamp(textField(ref.sourceAt))}] ${textField(ref.channel) || textField(ref.connector)} · ${author} · ${textField(ref.observationRef)}: ${text}`
    );
  }
  return lines;
}

function ledgerLines(replay: JsonValue | undefined): string[] {
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) return [];
  const digest = replay.ledgerDigest;
  if (!Array.isArray(digest)) return [];
  return digest.flatMap((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? [
          [
            textField(item.commitmentId),
            textField(item.title),
            textField(item.stage) || '-',
            textField(item.assignee) || '-',
            textField(item.lastEventTime) || '-',
          ].join(' | '),
        ]
      : []
  );
}

function boundedStimulus(row: MailboxRow): string {
  const lines = [
    '## Bounded stimulus',
    `kind: ${row.kind ?? 'unknown'}`,
    `stimulus_id: ${row.stimulusId}`,
    `channel: ${row.channelKey}`,
    `occurred_at: ${new Date(row.occurredAt).toISOString()}`,
    `preview: ${JSON.stringify(row.preview)}`,
  ];
  const messages = row.kind === 'source_delta' ? messageLines(row.payload) : null;
  if (messages === null) lines.push(`refs: ${JSON.stringify(row.refs)}`);
  if (row.kind === 'source_delta') {
    lines.push(
      row.refs.length === 0
        ? 'source_read: this replay window has no source messages.'
        : messages !== null
          ? 'source_read: each message line below carries its text (cut at 280 characters, marked …); call source.read with observationRefs only for the messages whose full text or attachment you need, batched per connector (the first segment of the channel) with source set to that connector.'
          : 'source_read: read these delta refs in one batched source.read call with observationRefs; content remains bounded per ref.'
    );
    const payload = row.payload;
    const replay =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.replay
        : undefined;
    if (replay && typeof replay === 'object' && !Array.isArray(replay)) {
      const instructions = replay.endInstructions;
      if (typeof instructions === 'string' && instructions.trim() !== '') {
        lines.push(`window_end_instructions: ${instructions}`);
      }
    }
    if (messages !== null) {
      const work = ledgerLines(replay);
      lines.push(
        `current_work (commitmentId | title | stage | assignee | lastEventTime), ${String(work.length)} items:`,
        ...work,
        `messages (KST, channel · sender · observationRef: text), ${String(messages.length)} lines:`,
        ...messages
      );
      return lines.join('\n');
    }
  }
  if (row.payload !== undefined) lines.push(`payload: ${JSON.stringify(row.payload)}`);
  return lines.join('\n');
}

/** The turn carries only the stimulus; the standing text is the session's system prompt. */
function assembledContent(row: MailboxRow): ContentBlock[] {
  return [{ type: 'text', text: boundedStimulus(row) }];
}

/** Deliver every model-bearing kind through one serialized owner session. */
export function createStimulusDelivery(options: StimulusDeliveryOptions): ReplayClockDelivery {
  let serialTail = Promise.resolve();
  let activeReplaySourceEndMs: number | undefined;

  const deliver: StimulusDelivery['deliver'] = async (row, context) => {
    let release!: () => void;
    const previous = serialTail;
    serialTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const replaySourceEndMs = activeReplaySourceEndMs;
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
          ...(replaySourceEndMs === undefined ? {} : { replaySourceEndMs }),
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
      if (activeReplaySourceEndMs === replaySourceEndMs) activeReplaySourceEndMs = undefined;
      release();
    }
  };

  return {
    deliver,
    prefer: ['owner_message'],
    setReplaySourceEndMs: (value) => {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error('Replay source ceiling must be a nonnegative epoch millisecond integer');
      }
      activeReplaySourceEndMs = value;
    },
    getReplaySourceEndMs: () => activeReplaySourceEndMs,
  };
}
