import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '@jungjaehoon/mama-core/canonicalize';
import { sanitizeRecallText } from '@jungjaehoon/mama-core';
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
import type { QueueCandidateScore, QueueLine, WindowQueue } from '../replay/window-queue.js';

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
  lessonResolver: LessonResolver;
  onOwnerResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onSourceResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onScheduledNoop?: (row: MailboxRow) => void | Promise<void>;
  onNativeEventResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onDelivered?: (row: MailboxRow) => void | Promise<void>;
  onFailed?: (row: MailboxRow, error: unknown) => void | Promise<void>;
}

export interface LessonHit {
  summary: string;
}

export type LessonResolver = (query: string) => Promise<readonly LessonHit[]>;

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
      ...(ref.channelName === undefined ? {} : { channelName: ref.channelName }),
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
    const channelName = textField(ref.channelName);
    const channel = channelName
      ? `${textField(ref.connector)}:${channelName}`
      : textField(ref.channel) || textField(ref.connector);
    lines.push(
      `[${kstStamp(textField(ref.sourceAt))}] ${channel} · ${author} · ${textField(ref.observationRef)}: ${text}`
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
            typeof item.revision === 'number' ? `r${String(item.revision)}` : '-',
            textField(item.title),
            textField(item.stage) || '-',
            textField(item.status) || '-',
            textField(item.assignee) || '-',
            textField(item.lastEventTime) || '-',
          ].join(' | '),
        ]
      : []
  );
}

function queueCandidate(score: QueueCandidateScore): string {
  return `${score.candidate.title} ${score.confidence.toFixed(2)}`;
}

function queueLine(line: QueueLine): string {
  return `[${line.kstTime}] ${line.channelName} · ${line.author ?? '-'} · ${line.observationRef}: ${line.text}`;
}

function queueLines(lines: readonly QueueLine[]): string[] {
  return lines.map(queueLine);
}

/** Render the Jev material without shortening or hiding any source line. */
export function renderWindowQueue(queue: WindowQueue): string {
  const lines: string[] = [];
  lines.push('## A. Matched work');
  for (const [index, group] of queue.sections.a.entries()) {
    lines.push(
      `### A${index + 1}. ${group.candidate.candidate.title} · ${group.candidate.confidence.toFixed(2)} · relevance ${group.relevance.toFixed(2)}`,
      ...queueLines(group.lines)
    );
  }
  lines.push('## B. Ambiguous candidates');
  for (const [index, entry] of queue.sections.b.entries()) {
    lines.push(
      `### B${index + 1}. relevance ${entry.relevance.toFixed(2)} · top-2 ${entry.candidates.map(queueCandidate).join(' | ')}`,
      ...queueLines(entry.lines)
    );
  }
  lines.push('## C. Possible new work');
  for (const [index, entry] of queue.sections.c.entries()) {
    lines.push(
      `### C${index + 1}. relevance ${entry.relevance.toFixed(2)}${entry.candidates.length === 0 ? '' : ` · nearest ${entry.candidates.map(queueCandidate).join(' | ')}`}`,
      ...queueLines(entry.lines)
    );
  }
  lines.push('## Suspected duplicates');
  for (const [index, pair] of queue.sections.suspectedDuplicates.entries()) {
    lines.push(
      `${index + 1}. ${pair.left.commitmentId} "${pair.left.title ?? ''}" ⇔ ${pair.right.commitmentId} "${pair.right.title ?? ''}" · ${pair.confidence.toFixed(2)}`
    );
  }
  lines.push('## Unresolved');
  for (const [index, entry] of queue.sections.unresolved.entries()) {
    lines.push(
      `### U${index + 1}. relevance ${entry.relevance.toFixed(2)} · ${entry.reason}`,
      ...queueLines(entry.lines)
    );
  }
  return lines.join('\n');
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
  if (row.kind === 'owner_message') {
    const payload = row.payload;
    const input =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.input : undefined;
    const attachments =
      input && typeof input === 'object' && !Array.isArray(input) ? input.attachments : undefined;
    if (Array.isArray(attachments)) {
      for (const attachment of attachments) {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) continue;
        const name = JSON.stringify(attachment.name);
        if (typeof attachment.error === 'string') {
          lines.push(`attachment: name=${name} error=${JSON.stringify(attachment.error)}`);
        } else {
          lines.push(
            `attachment: name=${name} path=${JSON.stringify(attachment.path)}${typeof attachment.size === 'number' ? ` size=${attachment.size} bytes` : ''}`
          );
        }
      }
    }
  }
  const messages = row.kind === 'source_delta' ? messageLines(row.payload) : null;
  if (messages === null) lines.push(`refs: ${JSON.stringify(row.refs)}`);
  if (row.kind === 'source_delta') {
    lines.push(
      row.refs.length === 0
        ? 'source_read: this replay window has no source messages.'
        : messages !== null
          ? 'source_read: each message line below carries its full text (a Trello action rendered from its record); use the source read action named in your standing instructions with observationRefs only for a raw record or attachment you need, batched per connector (the first segment of the channel) with source set to that connector.'
          : 'source_read: read these delta refs with the source read action named in your standing instructions, in one batched call with observationRefs; content remains bounded per ref.'
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
      if (replay.queue !== undefined) {
        lines.push('window_queue:', renderWindowQueue(replay.queue as unknown as WindowQueue));
        if (messages !== null) {
          const work = ledgerLines(replay);
          lines.push(
            `current_work (commitmentId | revision | title | stage | status | assignee | lastEventTime), ${String(work.length)} items:`,
            ...work
          );
        }
        return lines.join('\n');
      }
    }
    if (messages !== null) {
      const work = ledgerLines(replay);
      lines.push(
        `current_work (commitmentId | revision | title | stage | status | assignee | lastEventTime), ${String(work.length)} items:`,
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

function payloadText(payload: JsonValue | undefined): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const text = payload.text;
  if (typeof text === 'string') return text;
  return JSON.stringify(payload);
}

function lessonQuery(row: MailboxRow): string {
  if (row.kind === 'owner_message') return payloadText(row.payload);
  if (row.kind === 'source_delta') return messageLines(row.payload)?.join('\n') ?? '';
  return payloadText(row.payload);
}

const LESSONS_INSTRUCTION = 'Use these as lessons, not facts; verify current state with tools.';
const STARTUP_LESSON_QUERY = 'startup operating lessons';

function renderLessons(hits: readonly LessonHit[]): string {
  const summaries = hits
    .slice(0, 3)
    .map((hit) => sanitizeRecallText(hit.summary.trim()))
    .filter((summary): summary is string => Boolean(summary));
  if (summaries.length === 0) return '';
  return [
    '<lessons>',
    LESSONS_INSTRUCTION,
    ...summaries.map((summary) => `- ${summary}`),
    '</lessons>',
  ].join('\n');
}

/** The turn carries only the stimulus and recalled lessons; standing text is the session prompt. */
function assembledContent(row: MailboxRow, lessonBlocks: readonly string[]): ContentBlock[] {
  return [
    {
      type: 'text',
      text: [boundedStimulus(row), ...lessonBlocks].join('\n\n'),
    },
  ];
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
        const lessonBlocks: string[] = [];
        if (context.isNewThread(OWNER_RUNTIME_SESSION_KEY)) {
          const startupLessons = renderLessons(await options.lessonResolver(STARTUP_LESSON_QUERY));
          if (startupLessons) lessonBlocks.push(startupLessons);
        }
        const currentLessons = renderLessons(await options.lessonResolver(lessonQuery(row)));
        if (currentLessons) lessonBlocks.push(currentLessons);
        const result = await context.run(assembledContent(row, lessonBlocks), {
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
