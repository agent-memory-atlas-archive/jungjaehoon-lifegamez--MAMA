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
import { liveDeltaRoutingInstruction, type OwnerRuntimeBackend } from './owner-system-prompt.js';
import { buildScheduledReportPrompt } from './report-prompts.js';
import { workListTitleTextScore } from '../api/work-actions.js';

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
  openWorkCandidates?: () => Promise<unknown>;
  wikiEnabled?: boolean;
  formattingRoutes?: { reports: string; notifications: string };
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
  return wrapUntrustedContent('source_delta', lines.join('\n'));
}

function boundedStimulus(
  row: MailboxRow,
  liveSourceDelta: boolean,
  options: Pick<StimulusDeliveryOptions, 'wikiEnabled' | 'formattingRoutes' | 'backend'>,
  candidates: readonly string[] = []
): string {
  if (row.kind === 'scheduled')
    return buildScheduledReportPrompt(row.payload, new Date(row.occurredAt), {
      wikiEnabled: options.wikiEnabled,
      messenger: options.formattingRoutes?.reports,
    });
  const lines = [
    '## Bounded stimulus',
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
  const messages = row.kind === 'source_delta' ? messageLines(row.payload) : null;
  if (messages === null) lines.push(`refs: ${JSON.stringify(row.refs)}`);
  if (row.kind === 'source_delta') {
    if (liveSourceDelta) {
      lines.push(
        `response_routing: ${liveDeltaRoutingInstruction(options.backend ?? 'codex', options.wikiEnabled)}`
      );
      lines.push(`formatting: ${options.formattingRoutes?.notifications ?? 'telegram'}`);
      if (candidates.length > 0) lines.push('candidates (you decide):', ...candidates);
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
        `messages (KST, channel · sender · observationRef: text), ${String(messages.length)} lines:`,
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

function stimulusText(row: MailboxRow): string {
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return '';
  const refs = row.payload.refs;
  return Array.isArray(refs)
    ? refs
        .flatMap((ref) =>
          ref && typeof ref === 'object' && !Array.isArray(ref)
            ? [textField(ref.contentPreview)]
            : []
        )
        .join(' ')
    : '';
}

function stimulusChannels(row: MailboxRow): Set<string> {
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload))
    return new Set();
  const refs = row.payload.refs;
  if (!Array.isArray(refs)) return new Set();
  return new Set(
    refs.flatMap((ref) =>
      ref && typeof ref === 'object' && !Array.isArray(ref)
        ? [textField(ref.channel), textField(ref.channelName)].filter(Boolean)
        : []
    )
  );
}

function pipelineText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pipelineTime(value: unknown): string {
  const time = typeof value === 'number' ? value : Date.parse(pipelineText(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function relatedWorkCandidates(row: MailboxRow, workItems: unknown): string[] {
  const rows: unknown[] = Array.isArray(workItems) ? workItems : [];
  const channels = stimulusChannels(row);
  const query = stimulusText(row);
  const cutoff = row.occurredAt - 14 * 24 * 60 * 60 * 1000;
  const candidates = rows.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const title = pipelineText(item.title);
    const commitmentId = pipelineText(item.commitmentId);
    const changedAt = typeof item.updatedAt === 'number' ? item.updatedAt : Number.NaN;
    if (!title || !commitmentId || !Number.isFinite(changedAt) || changedAt < cutoff) return [];
    const sameChannel = channels.has(pipelineText(item.sourceChannel));
    const overlap = workListTitleTextScore(query, title);
    if (!sameChannel && overlap === 0) return [];
    return [{ item, title, commitmentId, overlap, sameChannel, changedAt }];
  });
  return candidates
    .sort(
      (a, b) =>
        Number(b.sameChannel) - Number(a.sameChannel) ||
        b.overlap - a.overlap ||
        b.changedAt - a.changedAt
    )
    .slice(0, 5)
    .map(
      ({ item, title, commitmentId }) =>
        `${title} | ${pipelineText(item.stage) || '-'} | ${pipelineText(item.assignee) || '-'} | ${pipelineTime(item.updatedAt)} | ${commitmentId}`
    );
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function guidanceLine(entry: GuidanceEntry): string {
  const when = entry.applies_when
    ? `applies when: ${oneLine(entry.applies_when)}`
    : `summary: ${oneLine(entry.summary)}`;
  return `${oneLine(entry.id)} | ${entry.kind} | ${oneLine(entry.topic)} | ${when}`;
}

function guidanceVersion(entry: GuidanceEntry): string {
  return `${String(entry.updated_at)}\0${entry.kind}\0${entry.status}`;
}

function activeGuidance(entries: readonly GuidanceEntry[]): GuidanceEntry[] {
  return entries
    .filter((entry) => entry.status === 'active')
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
}

function renderGuidanceIndex(entries: readonly GuidanceEntry[]): string {
  return [
    '<guidance-index>',
    ...activeGuidance(entries).map(guidanceLine),
    '</guidance-index>',
  ].join('\n');
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
      changes.push(`${before === undefined ? 'added' : 'revised'}: ${guidanceLine(entry)}`);
    } else if (before?.endsWith('\0active')) {
      changes.push(
        `retired: ${oneLine(entry.id)} | ${entry.kind} | ${oneLine(entry.topic)} | status: ${entry.status}`
      );
    }
  }
  return changes.length === 0
    ? ''
    : [
        '<guidance-delta>',
        ...changes.sort((left, right) => left.localeCompare(right)),
        '</guidance-delta>',
      ].join('\n');
}

/** The turn carries the stimulus plus the session index or guidance changes. */
function assembledContent(
  row: MailboxRow,
  sessionBlocks: readonly string[],
  liveSourceDelta: boolean,
  options: Pick<StimulusDeliveryOptions, 'wikiEnabled' | 'formattingRoutes' | 'backend'>,
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
          const pipeline =
            isNewSession ? await options.openWorkPipeline?.() : undefined;
          const entries = await options.guidanceResolver();
          const sessionKey = OWNER_RUNTIME_SESSION_KEY;
          const lastDelivered = guidanceBySessionKey.get(sessionKey);
          if (isNewSession) {
            sessionBlocks.push(renderGuidanceIndex(entries));
            if (pipeline !== undefined) {
              sessionBlocks.push(
                `<open-work-pipeline>\n${JSON.stringify(pipeline)}\n</open-work-pipeline>`
              );
            }
            const exchanges = renderRecentOwnerExchanges(
              (await options.recentOwnerExchanges?.(row)) ?? []
            );
            if (exchanges) sessionBlocks.push(exchanges);
          } else if (lastDelivered === undefined) {
            sessionBlocks.push(renderGuidanceIndex(entries));
          } else {
            const delta = renderGuidanceDelta(entries, lastDelivered);
            if (delta) sessionBlocks.push(delta);
          }
          pendingGuidanceState = new Map(
            entries.map((entry) => [entry.id, guidanceVersion(entry)])
          );
          return assembledContent(
            row,
            sessionBlocks,
            liveSourceDelta,
            options,
            liveSourceDelta ? relatedWorkCandidates(row, await options.openWorkCandidates?.()) : []
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
