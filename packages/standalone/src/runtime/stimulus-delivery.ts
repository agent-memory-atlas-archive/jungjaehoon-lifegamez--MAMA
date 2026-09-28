import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '@jungjaehoon/mama-core/canonicalize';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { MemoryKind, MemoryStatus } from '@jungjaehoon/mama-core/memory/types';
import type { ContentBlock } from '@jungjaehoon/mama-core/runtime/drivers/types';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import type {
  RuntimeHandle,
  StimulusDelivery,
  StimulusReceipt,
} from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { NativeTurnResultRecord } from '@jungjaehoon/mama-core/runtime/native-input-journal';
import type { SourceDelta } from '../connectors/framework/polling-scheduler.js';
import type { QueueCandidateScore, QueueLine, WindowQueue } from '../replay/window-queue.js';
import { renderRecentOwnerExchanges, type OwnerExchange } from './recent-owner-exchanges.js';
import type { OwnerRuntimeBackend } from './owner-system-prompt.js';
import { buildScheduledReportPrompt } from './report-prompts.js';
import { localStamp, type TimeZoneSetting } from './timezone.js';
import { workListTitleTextScore, type OpenWorkCandidate } from '../api/work-actions.js';
import type { ReportSlot } from '../api/report-handler.js';

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
  guidanceResolver: GuidanceResolver;
  backend?: OwnerRuntimeBackend;
  openWorkPipeline?: () => Promise<unknown>;
  openWorkCandidates?: () => Promise<readonly OpenWorkCandidate[]>;
  boardSnapshot?: () => Promise<Record<string, ReportSlot>>;
  wikiEnabled?: boolean;
  formattingRoutes?: { reports: string; notifications: string };
  timeZone: TimeZoneSetting;
  readResult?: (row: MailboxRow) => NativeTurnResultRecord | null;
  onUncertain?: StimulusDelivery['onUncertain'];
  recentOwnerExchanges?: (
    row: MailboxRow
  ) => readonly OwnerExchange[] | Promise<readonly OwnerExchange[]>;
  onOwnerResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onSourceResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onScheduledResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onNativeEventResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onDelivered?: (row: MailboxRow, modelRunId: string | null) => void | Promise<void>;
  onFailed?: (row: MailboxRow, reason: string, modelRunId: string | null) => void | Promise<void>;
}

export interface GuidanceEntry {
  id: string;
  kind: Extract<MemoryKind, 'lesson' | 'preference' | 'constraint' | 'workflow'>;
  topic: string;
  summary: string;
  status: MemoryStatus;
  updated_at: number | string;
  applies_when?: string;
  steps?: string[];
  evidence_checks?: string[];
}

export type GuidanceResolver = () => Promise<readonly GuidanceEntry[]>;

export interface ReplayClockDelivery extends StimulusDelivery {
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
      // A failed accepted turn will never run again. Keep a recorded answer pending only
      // until reconciliation delivers it, so recovery cannot replace it with an interruption.
      if (row?.nativeDelivery?.state === 'uncertain') {
        const receipt = row.nativeDelivery.receipt;
        return Boolean(
          receipt && runtime.mailbox!.nativeInputs.resultForReceipt(receipt, principalId)
        );
      }
      return row?.status === 'pending';
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

function textField(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A source delta whose refs carry message text is rendered as one line per message.
 * The session keeps every turn, so ids, hashes and connector metadata would be re-read on
 * each later model call; the stored observation stays one source.read away.
 */
function messageLines(payload: JsonValue | undefined, timeZone: TimeZoneSetting): string[] | null {
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
      `[${localStamp(textField(ref.sourceAt), timeZone.get())}] ${channel} · ${author} · ${textField(ref.observationRef)}: ${text}`
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
  return `[${line.localTime}] ${line.channelName} · ${line.author ?? '-'} · ${line.observationRef}: ${line.text}`;
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
  return wrapUntrustedContent('source_delta', lines.join('\n'));
}

function boundedStimulus(
  row: MailboxRow,
  liveSourceDelta: boolean,
  options: Pick<
    StimulusDeliveryOptions,
    'wikiEnabled' | 'formattingRoutes' | 'backend' | 'timeZone'
  >,
  candidates: readonly string[] = []
): string {
  if (row.kind === 'scheduled')
    return buildScheduledReportPrompt(row.payload, new Date(row.occurredAt), {
      messenger: options.formattingRoutes?.reports,
      timeZone: options.timeZone.get(),
    });
  const lines = [
    '## Bounded stimulus',
    `owner timezone: ${options.timeZone.get()}`,
    `kind: ${row.kind ?? 'unknown'}`,
    `stimulus_id: ${row.stimulusId}`,
    `channel: ${row.channelKey}`,
    `occurred_at: ${new Date(row.occurredAt).toISOString()}`,
    `preview: ${row.kind === 'source_delta' ? wrapUntrustedContent('source_delta', JSON.stringify(row.preview)) : JSON.stringify(row.preview)}`,
  ];
  if (row.kind === 'owner_message') {
    const messenger = row.stimulusId.split(':', 1)[0];
    lines.push(`messenger: ${messenger}`);
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
  const messages = row.kind === 'source_delta' ? messageLines(row.payload, options.timeZone) : null;
  if (messages === null) lines.push(`refs: ${JSON.stringify(row.refs)}`);
  if (row.kind === 'source_delta') {
    if (liveSourceDelta) {
      lines.push(
        'End this turn with exactly one marker: [notify] followed by the message the owner receives, or [ack]. Owner-answer turns never carry these markers.'
      );
      lines.push(`formatting: ${options.formattingRoutes?.notifications ?? 'telegram'}`);
      if (candidates.length > 0) lines.push('candidates (you decide):', ...candidates);
    } else {
      lines.push(
        'This replay window is history and is not delivered to the owner: notification instructions do not apply, and the turn ends without [notify] or [ack].'
      );
    }
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
        `messages (${options.timeZone.get()}, channel · sender · observationRef: text), ${String(messages.length)} lines:`,
        ...messages.map((message) => wrapUntrustedContent('source_delta', message))
      );
      return lines.join('\n');
    }
  }
  if (row.payload !== undefined)
    lines.push(
      `payload: ${row.kind === 'source_delta' ? wrapUntrustedContent('source_delta', JSON.stringify(row.payload)) : JSON.stringify(row.payload)}`
    );
  return lines.join('\n');
}

function sourcePayloadObject(row: MailboxRow): Record<string, JsonValue> | null {
  return row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? (row.payload as Record<string, JsonValue>)
    : null;
}

function payloadRefs(payload: Record<string, JsonValue>): Array<Record<string, JsonValue>> {
  return Array.isArray(payload.refs)
    ? payload.refs.filter(
        (ref): ref is Record<string, JsonValue> =>
          ref !== null && typeof ref === 'object' && !Array.isArray(ref)
      )
    : [];
}

/** The delta's text: its bounded preview lines (what the collector saw) and any ref previews. */
function stimulusText(row: MailboxRow): string {
  const payload = sourcePayloadObject(row);
  if (!payload) return '';
  const preview = Array.isArray(payload.preview)
    ? payload.preview.filter((line): line is string => typeof line === 'string')
    : [];
  return [...preview, ...payloadRefs(payload).map((ref) => textField(ref.contentPreview))]
    .filter(Boolean)
    .join(' ');
}

/**
 * The delta's channels qualified by connector (`connector:channel`), the same form the host reads
 * from each work item's evidence; the same channel id on two connectors is two channels.
 */
function stimulusChannels(row: MailboxRow): Set<string> {
  const payload = sourcePayloadObject(row);
  if (!payload) return new Set();
  const channel = textField(payload.channel);
  const collector = textField(payload.collector);
  const keys = new Set<string>();
  if (collector && channel) keys.add(`${collector}:${channel}`);
  for (const ref of payloadRefs(payload)) {
    const connector = textField(ref.connector);
    const refChannel = textField(ref.channel) || channel;
    if (connector && refChannel) keys.add(`${connector}:${refChannel}`);
  }
  return keys;
}

function relatedWorkCandidates(row: MailboxRow, items: readonly OpenWorkCandidate[]): string[] {
  const channels = stimulusChannels(row);
  const query = stimulusText(row);
  const cutoff = row.occurredAt - 14 * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => item.updatedAt >= cutoff)
    .map((item) => ({
      item,
      sameChannel: item.evidenceChannels.some((channel) => channels.has(channel)),
      overlap: workListTitleTextScore(query, item.title),
    }))
    .filter(({ sameChannel, overlap }) => sameChannel || overlap > 0)
    .sort(
      (a, b) =>
        Number(b.sameChannel) - Number(a.sameChannel) ||
        b.overlap - a.overlap ||
        b.item.updatedAt - a.item.updatedAt
    )
    .slice(0, 5)
    .map(
      ({ item }) =>
        `${item.title} | ${item.stage || '-'} | ${item.assignee || '-'} | ${new Date(item.updatedAt).toISOString()} | ${item.commitmentId}`
    );
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** One owner correction in full: its header, what it says and, for a procedure, its steps. */
function guidanceBlock(entry: GuidanceEntry): string {
  return [
    `${oneLine(entry.id)} | ${entry.kind} | ${oneLine(entry.topic)}${entry.applies_when ? ` | applies when: ${oneLine(entry.applies_when)}` : ''}`,
    `  ${oneLine(entry.summary)}`,
    ...(entry.steps ?? []).map((step, index) => `  ${index + 1}. ${oneLine(step)}`),
    ...(entry.evidence_checks ?? []).map((check) => `  check: ${oneLine(check)}`),
  ].join('\n');
}

function guidanceVersion(entry: GuidanceEntry): string {
  return `${String(entry.updated_at)}\0${entry.kind}\0${entry.status}`;
}

/** Active corrections oldest first, so a later correction reads after the one it refines. */
function activeGuidance(entries: readonly GuidanceEntry[]): GuidanceEntry[] {
  return entries
    .filter((entry) => entry.status === 'active')
    .slice()
    .sort(
      (left, right) => guidanceTime(left) - guidanceTime(right) || left.id.localeCompare(right.id)
    );
}

function guidanceTime(entry: GuidanceEntry): number {
  return typeof entry.updated_at === 'number' ? entry.updated_at : Date.parse(entry.updated_at);
}

function renderGuidanceIndex(entries: readonly GuidanceEntry[]): string {
  return [
    '<owner-corrections>',
    ...activeGuidance(entries).map(guidanceBlock),
    '</owner-corrections>',
  ].join('\n');
}

function renderCurrentBoard(slots: Record<string, ReportSlot>): string {
  const sections = Object.entries(slots).map(
    ([slot, value]) =>
      `<slot name="${slot}" updatedAt="${new Date(value.updatedAt).toISOString()}">\n${value.html}\n</slot>`
  );
  return `<current-board>\n${sections.join('\n')}\n</current-board>`;
}

function renderGuidanceDelta(
  entries: readonly GuidanceEntry[],
  previous: ReadonlyMap<string, string>
): string {
  const changes: string[] = [];
  for (const entry of entries) {
    const before = previous.get(entry.id);
    const after = guidanceVersion(entry);
    if (before === after) continue;
    if (entry.status === 'active') {
      changes.push(`${before === undefined ? 'added' : 'revised'}: ${guidanceBlock(entry)}`);
    } else if (before?.endsWith('\0active')) {
      changes.push(
        `${entry.status === 'superseded' ? 'replaced' : 'retired'}: ${oneLine(entry.id)} | ${entry.kind} | ${oneLine(entry.topic)} | status: ${entry.status}`
      );
    }
  }
  return changes.length === 0
    ? ''
    : [
        '<owner-corrections-changed>',
        ...changes.sort((left, right) => left.localeCompare(right)),
        '</owner-corrections-changed>',
      ].join('\n');
}

/** The turn carries the stimulus plus the session index or guidance changes. */
function assembledContent(
  row: MailboxRow,
  sessionBlocks: readonly string[],
  liveSourceDelta: boolean,
  options: Pick<
    StimulusDeliveryOptions,
    'wikiEnabled' | 'formattingRoutes' | 'backend' | 'timeZone'
  >,
  candidates: readonly string[] = []
): ContentBlock[] {
  return [
    {
      type: 'text',
      text: [...sessionBlocks, boundedStimulus(row, liveSourceDelta, options, candidates)].join(
        '\n\n'
      ),
    },
  ];
}

/** One bounded log line; preserve the original thrown error for runtime settlement. */
export function stimulusFailureReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function replaySourceCeiling(row: MailboxRow): number | undefined {
  const payload = row.payload;
  if (
    row.kind !== 'source_delta' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.replay === undefined
  )
    return undefined;
  const replay = payload.replay;
  // Replay windows are half-open; malformed bounds must never permit unbounded source reads.
  if (
    !replay ||
    typeof replay !== 'object' ||
    Array.isArray(replay) ||
    !Number.isSafeInteger(replay.windowEndMs) ||
    Number(replay.windowEndMs) <= 0
  ) {
    throw new Error('Replay windowEndMs must provide a nonnegative inclusive source ceiling');
  }
  return Number(replay.windowEndMs) - 1;
}

/** Deliver every model-bearing kind through one serialized owner session. */
export function createStimulusDelivery(options: StimulusDeliveryOptions): ReplayClockDelivery {
  let serialTail = Promise.resolve();
  let activeReplaySourceEndMs: number | undefined;
  const guidanceBySessionKey = new Map<string, Map<string, string>>();

  const deliverResult = async (
    row: MailboxRow,
    result: NativeTurnResult,
    modelRunId = result.modelRunId
  ): Promise<void> => {
    if (row.kind === 'owner_message') await options.onOwnerResult?.(row, result);
    if (row.kind === 'source_delta' && replaySourceCeiling(row) === undefined)
      await options.onSourceResult?.(row, result);
    if (row.kind === 'scheduled') await options.onScheduledResult?.(row, result);
    if (row.kind === 'native_event') await options.onNativeEventResult?.(row, result);
    await options.onDelivered?.(row, modelRunId);
  };

  const deliver: StimulusDelivery['deliver'] = async (row, context) => {
    let release!: () => void;
    const previous = serialTail;
    serialTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let modelRunId: string | null = null;
    let pendingGuidanceState: Map<string, string> | undefined;
    try {
      const replaySourceEndMs = replaySourceCeiling(row);
      activeReplaySourceEndMs = replaySourceEndMs;
      const liveSourceDelta = row.kind === 'source_delta' && replaySourceEndMs === undefined;
      if (
        row.kind !== 'owner_message' &&
        row.kind !== 'source_delta' &&
        row.kind !== 'scheduled' &&
        row.kind !== 'native_event'
      ) {
        throw new Error('Stimulus kind is missing; no owner turn can be assembled');
      }
      const result = await context.run(assembledContent(row, [], liveSourceDelta, options), {
        onModelRunStarted: (id: string) => {
          modelRunId = id;
        },
        prepareSessionContent: async ({ isNewSession }) => {
          const sessionBlocks: string[] = [];
          const pipeline = isNewSession ? await options.openWorkPipeline?.() : undefined;
          const guidance = await options.guidanceResolver();
          const sessionKey = OWNER_RUNTIME_SESSION_KEY;
          const lastDelivered = guidanceBySessionKey.get(sessionKey);
          if (isNewSession) {
            sessionBlocks.push(renderGuidanceIndex(guidance));
            if (pipeline !== undefined) {
              sessionBlocks.push(
                `<open-work-pipeline>\n${JSON.stringify(pipeline)}\n</open-work-pipeline>`
              );
            }
            const board = await options.boardSnapshot?.();
            // Board slots quote source content; they reach the model as untrusted evidence, as
            // report.read results do.
            if (board !== undefined)
              sessionBlocks.push(wrapUntrustedContent('report.read', renderCurrentBoard(board)));
            const exchanges = renderRecentOwnerExchanges(
              (await options.recentOwnerExchanges?.(row)) ?? []
            );
            if (exchanges) sessionBlocks.push(exchanges);
          } else if (lastDelivered === undefined) {
            sessionBlocks.push(renderGuidanceIndex(guidance));
          } else {
            const delta = renderGuidanceDelta(guidance, lastDelivered);
            if (delta) sessionBlocks.push(delta);
          }
          pendingGuidanceState = new Map(
            guidance.map((entry) => [entry.id, guidanceVersion(entry)])
          );
          return assembledContent(
            row,
            sessionBlocks,
            liveSourceDelta,
            options,
            liveSourceDelta
              ? relatedWorkCandidates(row, (await options.openWorkCandidates?.()) ?? [])
              : []
          );
        },
        sessionKey: OWNER_RUNTIME_SESSION_KEY,
        source: row.kind,
        channelId: row.channelKey,
        sourceMessageRef: row.stimulusId,
        ...(replaySourceEndMs === undefined ? {} : { replaySourceEndMs }),
      });
      if (pendingGuidanceState !== undefined) {
        guidanceBySessionKey.set(OWNER_RUNTIME_SESSION_KEY, pendingGuidanceState);
      }
      // A commit failure withholds result provenance, but the opened run still identifies this turn.
      modelRunId = result.modelRunId ?? modelRunId;
      await deliverResult(row, result, modelRunId);
    } catch (error) {
      await options.onFailed?.(row, stimulusFailureReason(error), modelRunId);
      throw error;
    } finally {
      activeReplaySourceEndMs = undefined;
      release();
    }
  };

  return {
    deliver,
    prefer: ['owner_message'],
    ...(options.onUncertain === undefined ? {} : { onUncertain: options.onUncertain }),
    reconcile: async (row) => {
      const result = options.readResult?.(row);
      if (result) {
        await deliverResult(row, { ...result, history: [] });
        return 'settled';
      }
      // Core invokes reconciliation only when no delivery in this process owns
      // the input. Never rerun an orphan dispatched to a model without its final result.
      if (row.nativeDelivery?.state === 'dispatching' || row.nativeDelivery?.state === 'accepted') {
        const reason =
          row.kind === 'scheduled'
            ? 'Scheduled report interrupted before completion; retry on the next report tick'
            : `${row.kind} interrupted before completion; no stored result`;
        await options.onFailed?.(row, reason, null);
        // Core parks the orphan uncertain, preserving its receipt and any result.
        throw new Error(reason);
      }
      if (row.nativeDelivery?.state === 'uncertain') {
        throw new Error(`${row.kind} remains uncertain after restart; no stored result`);
      }
      return 'unresolved';
    },
    getReplaySourceEndMs: () => activeReplaySourceEndMs,
  };
}
