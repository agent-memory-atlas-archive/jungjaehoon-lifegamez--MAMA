import { cosineSimilarity, generateEmbedding } from '@jungjaehoon/mama-core';
import type { JevAnswers, JevBatchRequest, JevQuestion } from './jev-client.js';
import { pool } from './jev-client.js';
import { declareModelCache } from '../runtime/model-cache.js';

export interface ReplayQueueEvent {
  readonly connector: string;
  readonly sourceId: string;
  readonly observationRef: string;
  readonly channelKey: string;
  readonly channelName?: string;
  readonly sourceAtMs: number;
  readonly rawRowId: number;
  readonly author?: string;
  readonly contentPreview?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface QueueWorkItem {
  readonly commitmentId: string;
  readonly title: string | null;
  readonly stage: string | null;
  readonly status: string | null;
}

export interface QueueTrelloCard {
  readonly cardId: string;
  readonly name: string;
  readonly firstActivityMs: number;
  readonly lastActivityMs: number;
  readonly list: string | null;
  readonly listHistory: readonly string[];
}

export interface QueueLine {
  readonly connector: string;
  readonly channelName: string;
  readonly author: string | null;
  readonly kstTime: string;
  readonly sourceAtMs: number;
  readonly observationRef: string;
  readonly text: string;
}

export interface QueueCandidate {
  readonly key: string;
  readonly kind: 'work' | 'trello';
  readonly id: string;
  readonly title: string;
  readonly facts: Record<string, unknown>;
  readonly hints: readonly string[];
}

export interface QueueCandidateScore {
  readonly candidate: QueueCandidate;
  readonly confidence: number;
  readonly source: readonly string[];
}

export interface QueueAGroup {
  readonly candidate: QueueCandidateScore;
  readonly relevance: number;
  readonly lines: readonly QueueLine[];
}

export interface QueueBEntry {
  readonly relevance: number;
  readonly candidates: readonly QueueCandidateScore[];
  readonly lines: readonly QueueLine[];
}

export interface QueueCEntry {
  readonly relevance: number;
  readonly candidates: readonly QueueCandidateScore[];
  readonly lines: readonly QueueLine[];
}

export interface QueueUnresolvedEntry {
  readonly relevance: number;
  readonly reason: string;
  readonly lines: readonly QueueLine[];
}

export interface QueueDuplicatePair {
  readonly left: QueueWorkItem;
  readonly right: QueueWorkItem;
  readonly confidence: number;
}

export interface WindowQueue {
  readonly window: { startMs: number; endMs: number };
  readonly lines: readonly QueueLine[];
  readonly sections: {
    readonly a: readonly QueueAGroup[];
    readonly b: readonly QueueBEntry[];
    readonly c: readonly QueueCEntry[];
    readonly suspectedDuplicates: readonly QueueDuplicatePair[];
    readonly unresolved: readonly QueueUnresolvedEntry[];
  };
}

export interface QueueJev {
  ask(request: JevBatchRequest): Promise<JevAnswers>;
}

export interface QueueEmbedder {
  embed(text: string, role: 'query' | 'passage'): Promise<Float32Array>;
}

export interface WindowQueueInput {
  readonly startMs: number;
  readonly endMs: number;
  readonly events: readonly ReplayQueueEvent[];
  readonly workItems: readonly QueueWorkItem[];
  readonly trelloCards: readonly QueueTrelloCard[];
  readonly vocabulary: unknown;
  readonly jev: QueueJev;
  readonly embedder?: QueueEmbedder;
  readonly topK?: number;
}

export class WindowQueueIncompleteError extends Error {
  readonly observationRefs: readonly string[];
  readonly cause: unknown;

  constructor(observationRefs: readonly string[], cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Window queue incomplete for observation refs: ${observationRefs.join(', ')}: ${message}`
    );
    this.name = 'WindowQueueIncompleteError';
    this.observationRefs = Object.freeze([...observationRefs]);
    this.cause = cause;
  }
}

interface QueueChunk {
  readonly id: number;
  readonly events: readonly ReplayQueueEvent[];
  readonly lines: readonly QueueLine[];
  readonly text: string;
  readonly observationRefs: readonly string[];
}

interface RankedChunk {
  readonly chunk: QueueChunk;
  readonly relevance: number;
  readonly ranked: readonly QueueCandidateScore[];
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const MAX_ADJACENT_GAP_MS = 6 * 60 * 60 * 1_000;
const CARD_ACTIVITY_RADIUS_MS = 24 * 60 * 60 * 1_000;
const HIGH_CONFIDENCE = 0.8;
const MEDIUM_CONFIDENCE = 0.5;

const WORK_CANDIDATES = 8;
const DUPLICATE_BATCH = 20;

// Question wording is the pipeline's, carried from the archive backfill; the owner's
// vocabulary notes (vocabulary.notes.*) travel in the state as domain context.
// The archive asked "same single work item?" on production channels only; owner rooms also
// carry planning and billing talk that is not a work item yet, so a chunk is one topic.
const PAIR_QUESTION = (id: number) =>
  `In pair id=${id}: does B continue the same topic or exchange as A (one conversation thread)?`;
const RELEVANCE_QUESTION =
  'Is this CHUNK owner work - a request, decision, schedule, billing, delivery, feedback, or a change to a work item - rather than greetings or general talk?';
const CANDIDATE_QUESTION = (title: string, key: string) =>
  `Is this chunk about the work item "${title}" (candidate ${key}; see its facts in candidates)?`;
const DUPLICATE_QUESTION = (id: number) =>
  `In pair id=${id}: are left and right the same deliverable, one work item recorded twice?`;

/** One embedding per text for the whole window: candidate generation reuses them. */
function vectorCache(embedder: QueueEmbedder) {
  const cache = new Map<string, Promise<Float32Array>>();
  return (text: string, role: 'query' | 'passage') => {
    const key = `${role}\0${text}`;
    let value = cache.get(key);
    if (value === undefined) {
      value = embedder.embed(text, role);
      cache.set(key, value);
    }
    return value;
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Window queue ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function note(vocabulary: unknown, key: string): string {
  const root = record(vocabulary, 'vocabulary');
  const notes = record(root.notes, 'vocabulary.notes');
  const value = text(notes[key]);
  if (value === null) throw new Error(`Window queue vocabulary note is missing: ${key}`);
  return value;
}

function assertWindow(startMs: number, endMs: number): void {
  if (!Number.isSafeInteger(startMs) || startMs < 0)
    throw new Error('Window queue startMs is invalid');
  if (!Number.isSafeInteger(endMs) || endMs < startMs)
    throw new Error('Window queue endMs is invalid');
}

function kstTime(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

function toLine(event: ReplayQueueEvent): QueueLine {
  if (event.contentPreview === undefined) {
    throw new Error(`Window queue source ${event.connector}:${event.sourceId} has no full text`);
  }
  return {
    connector: event.connector,
    channelName: event.channelName ?? event.channelKey,
    author: event.author ?? null,
    kstTime: kstTime(event.sourceAtMs),
    sourceAtMs: event.sourceAtMs,
    observationRef: event.observationRef,
    text: event.contentPreview,
  };
}

function normalizeEvents(events: readonly ReplayQueueEvent[]): readonly ReplayQueueEvent[] {
  const seen = new Set<string>();
  return Object.freeze(
    [...events]
      .sort((left, right) => left.sourceAtMs - right.sourceAtMs || left.rawRowId - right.rawRowId)
      .filter((event) => {
        const key = `${event.connector}\0${event.sourceId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
  );
}

function threadKey(event: ReplayQueueEvent): string | null {
  const metadata = event.metadata ?? {};
  const thread = text(metadata.threadTs ?? metadata.threadId);
  return thread === null ? null : `${event.channelKey}\0${thread}`;
}

function allObservationRefs(events: readonly ReplayQueueEvent[]): readonly string[] {
  return Object.freeze([...new Set(events.map((event) => event.observationRef))]);
}

async function ask(
  jev: QueueJev,
  state: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
  observationRefs: readonly string[]
): Promise<JevAnswers> {
  try {
    return await jev.ask({ state, questions, observationRefs });
  } catch (error) {
    if (error instanceof WindowQueueIncompleteError) throw error;
    const refs =
      error !== null && typeof error === 'object' && 'observationRefs' in error
        ? (error as { observationRefs?: unknown }).observationRefs
        : undefined;
    throw new WindowQueueIncompleteError(
      Array.isArray(refs)
        ? refs.filter((ref): ref is string => typeof ref === 'string')
        : observationRefs,
      error
    );
  }
}

function score(answers: JevAnswers, key: string, refs: readonly string[]): number {
  const value = answers[key]?.noul;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new WindowQueueIncompleteError(refs, new Error(`Jev verdict is missing: ${key}`));
  }
  return value;
}

async function buildChunks(
  events: readonly ReplayQueueEvent[],
  jev: QueueJev,
  vocabulary: unknown
): Promise<QueueChunk[]> {
  const byThread = new Map<string, ReplayQueueEvent[]>();
  const unthreaded = new Map<string, ReplayQueueEvent[]>();
  for (const event of events) {
    const key = threadKey(event);
    const target = key === null ? unthreaded : byThread;
    const groupKey = key ?? event.channelKey;
    const group = target.get(groupKey) ?? [];
    group.push(event);
    target.set(groupKey, group);
  }
  const chunks: ReplayQueueEvent[][] = [];
  for (const group of byThread.values())
    chunks.push(group.sort((a, b) => a.sourceAtMs - b.sourceAtMs));
  const groups = [...unthreaded.values()].map((group) =>
    group.sort((a, b) => a.sourceAtMs - b.sourceAtMs)
  );
  await pool(groups, async (ordered) => {
    if (ordered.length === 0) return;
    // Adjacent pairs within the gap are judged together in one Jev call (archive batching).
    const pairs: Array<{ index: number; id: number }> = [];
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.sourceAtMs - ordered[index - 1]!.sourceAtMs <= MAX_ADJACENT_GAP_MS) {
        pairs.push({ index, id: pairs.length });
      }
    }
    const same = new Set<number>();
    if (pairs.length > 0) {
      const refs = allObservationRefs(ordered);
      const questions: Record<string, JevQuestion> = {};
      for (const pair of pairs)
        questions[`p${pair.id}`] = { type: 'noul', instructions: PAIR_QUESTION(pair.id) };
      const answers = await ask(
        jev,
        {
          pairs: pairs.map((pair) => ({
            id: pair.id,
            gap_minutes: Math.round(
              (ordered[pair.index]!.sourceAtMs - ordered[pair.index - 1]!.sourceAtMs) / 60_000
            ),
            A: toLine(ordered[pair.index - 1]!).text,
            B: toLine(ordered[pair.index]!).text,
          })),
          note: note(vocabulary, 'pairs'),
        },
        questions,
        refs
      );
      for (const pair of pairs)
        if (score(answers, `p${pair.id}`, refs) >= HIGH_CONFIDENCE) same.add(pair.index);
    }
    let current: ReplayQueueEvent[] = [ordered[0]!];
    for (let index = 1; index < ordered.length; index += 1) {
      if (same.has(index)) current.push(ordered[index]!);
      else {
        chunks.push(current);
        current = [ordered[index]!];
      }
    }
    chunks.push(current);
  });
  return chunks
    .sort((left, right) => left[0]!.sourceAtMs - right[0]!.sourceAtMs)
    .map((group, id) => {
      const lines = group.map(toLine);
      return {
        id,
        events: Object.freeze([...group]),
        lines: Object.freeze(lines),
        text: lines.map((line) => line.text).join('\n'),
        observationRefs: allObservationRefs(group),
      };
    });
}

function candidateHints(
  candidate: QueueCandidate,
  chunk: QueueChunk,
  vocabulary: unknown
): string[] {
  const hints: string[] = [];
  const lower = chunk.text.toLocaleLowerCase();
  if (lower.includes(candidate.title.toLocaleLowerCase())) hints.push('exact_name');
  const prefixes = record(vocabulary, 'vocabulary').codePrefixes;
  if (Array.isArray(prefixes)) {
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || prefix.trim() === '') continue;
      const pattern = new RegExp(
        `\\b${prefix.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}_\\d{4,8}\\b`,
        'iu'
      );
      if (pattern.test(chunk.text) && pattern.test(candidate.title)) hints.push('exact_code');
    }
  }
  return [...new Set(hints)];
}

function workCandidate(
  item: QueueWorkItem,
  chunk: QueueChunk,
  vocabulary: unknown
): QueueCandidate {
  const title = item.title ?? item.commitmentId;
  return {
    key: `work:${item.commitmentId}`,
    kind: 'work',
    id: item.commitmentId,
    title,
    facts: {
      commitmentId: item.commitmentId,
      title: item.title,
      stage: item.stage,
      status: item.status,
    },
    hints: candidateHints(
      {
        key: '',
        kind: 'work',
        id: item.commitmentId,
        title,
        facts: {},
        hints: [],
      },
      chunk,
      vocabulary
    ),
  };
}

function cardCandidate(
  card: QueueTrelloCard,
  chunk: QueueChunk,
  vocabulary: unknown
): QueueCandidate {
  return {
    key: `trello:${card.cardId}`,
    kind: 'trello',
    id: card.cardId,
    title: card.name,
    facts: {
      cardId: card.cardId,
      name: card.name,
      list: card.list,
      listHistory: card.listHistory,
      firstActivityMs: card.firstActivityMs,
      lastActivityMs: card.lastActivityMs,
    },
    hints: candidateHints(
      {
        key: '',
        kind: 'trello',
        id: card.cardId,
        title: card.name,
        facts: {},
        hints: [],
      },
      chunk,
      vocabulary
    ),
  };
}

function candidateCards(
  cards: readonly QueueTrelloCard[],
  chunk: QueueChunk,
  rankedCardKeys: readonly string[]
): QueueTrelloCard[] {
  const start =
    Math.min(...chunk.events.map((event) => event.sourceAtMs)) - CARD_ACTIVITY_RADIUS_MS;
  const end = Math.max(...chunk.events.map((event) => event.sourceAtMs)) + CARD_ACTIVITY_RADIUS_MS;
  return cards.filter(
    (card) =>
      (card.lastActivityMs >= start && card.firstActivityMs <= end) ||
      rankedCardKeys.includes(`trello:${card.cardId}`)
  );
}

function defaultEmbedder(): QueueEmbedder {
  declareModelCache();
  return { embed: (text, role) => generateEmbedding(text, role) };
}

async function rankedKeys<T>(
  items: readonly T[],
  key: (item: T) => string,
  name: (item: T) => string,
  chunk: QueueChunk,
  vector: ReturnType<typeof vectorCache>,
  topK: number
): Promise<readonly string[]> {
  if (items.length === 0 || topK <= 0) return [];
  const query = await vector(chunk.text, 'query');
  const scored: Array<{ key: string; similarity: number }> = [];
  for (const item of items) {
    scored.push({
      key: key(item),
      similarity: cosineSimilarity(query, await vector(name(item), 'passage')),
    });
  }
  return scored
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, topK)
    .map((item) => item.key);
}

async function classifyChunk(
  chunk: QueueChunk,
  input: WindowQueueInput,
  cards: readonly QueueTrelloCard[],
  vector: ReturnType<typeof vectorCache>
): Promise<RankedChunk> {
  // Candidate generation only (the archive's time window ∪ embedding top-K, and exact
  // name/code hints); which candidate it is stays with Jev and the owner agent.
  const cardKeys = await rankedKeys(
    cards,
    (card) => `trello:${card.cardId}`,
    (card) => card.name,
    chunk,
    vector,
    input.topK ?? 12
  );
  const workKeys = await rankedKeys(
    input.workItems,
    (item) => `work:${item.commitmentId}`,
    (item) => item.title ?? item.commitmentId,
    chunk,
    vector,
    WORK_CANDIDATES
  );
  const work = input.workItems
    .map((item) => workCandidate(item, chunk, input.vocabulary))
    .filter((candidate) => workKeys.includes(candidate.key) || candidate.hints.length > 0);
  const candidates = [
    ...work,
    ...candidateCards(cards, chunk, cardKeys).map((card) =>
      cardCandidate(card, chunk, input.vocabulary)
    ),
  ];
  const questions: Record<string, JevQuestion> = {
    relevance: { type: 'noul', instructions: RELEVANCE_QUESTION },
  };
  candidates.forEach((candidate, index) => {
    questions[`candidate-${index}`] = {
      type: 'noul',
      instructions: CANDIDATE_QUESTION(candidate.title, candidate.key),
    };
  });
  const answers = await ask(
    input.jev,
    {
      chunkIndex: chunk.id,
      chunk: chunk.lines.map((line, index) => `[${index + 1}] ${line.text}`).join('\n'),
      chunk_date: chunk.lines[0]?.kstTime ?? null,
      candidates: candidates.map((candidate) => ({
        ...candidate.facts,
        key: candidate.key,
        hints: candidate.hints,
      })),
      note: `${note(input.vocabulary, 'chunk')} ${note(input.vocabulary, 'cards')}`,
    },
    questions,
    chunk.observationRefs
  );
  const relevance = score(answers, 'relevance', chunk.observationRefs);
  const ranked = candidates
    .map(
      (candidate, index): QueueCandidateScore => ({
        candidate,
        confidence: score(answers, `candidate-${index}`, chunk.observationRefs),
        source: candidate.hints,
      })
    )
    .sort((left, right) => right.confidence - left.confidence);
  return { chunk, relevance, ranked };
}

async function duplicatePairs(
  input: WindowQueueInput,
  vector: ReturnType<typeof vectorCache>,
  observationRefs: readonly string[]
): Promise<readonly QueueDuplicatePair[]> {
  if (input.workItems.length < 2) return [];
  const vectors = await Promise.all(
    input.workItems.map((item) => vector(item.title ?? item.commitmentId, 'passage'))
  );
  const topK = input.topK ?? 3;
  const pairs = new Map<string, { left: number; right: number }>();
  for (let left = 0; left < input.workItems.length; left += 1) {
    const neighbors = input.workItems
      .map((_, right) => ({
        right,
        similarity: right === left ? -1 : cosineSimilarity(vectors[left]!, vectors[right]!),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
    for (const neighbor of neighbors) {
      const a = Math.min(left, neighbor.right);
      const b = Math.max(left, neighbor.right);
      if (a !== b) pairs.set(`${a}:${b}`, { left: a, right: b });
    }
  }
  const list = [...pairs.values()];
  const result: QueueDuplicatePair[] = [];
  const batches: Array<typeof list> = [];
  for (let start = 0; start < list.length; start += DUPLICATE_BATCH)
    batches.push(list.slice(start, start + DUPLICATE_BATCH));
  await pool(batches, async (batch) => {
    const questions: Record<string, JevQuestion> = {};
    batch.forEach((_, id) => {
      questions[`d${id}`] = { type: 'noul', instructions: DUPLICATE_QUESTION(id) };
    });
    const answers = await ask(
      input.jev,
      {
        pairs: batch.map((pair, id) => ({
          id,
          left: input.workItems[pair.left],
          right: input.workItems[pair.right],
        })),
        note: note(input.vocabulary, 'dup'),
      },
      questions,
      observationRefs
    );
    batch.forEach((pair, id) => {
      result.push({
        left: input.workItems[pair.left]!,
        right: input.workItems[pair.right]!,
        confidence: score(answers, `d${id}`, observationRefs),
      });
    });
  });
  return Object.freeze(result);
}

export function trelloCardsFromEvents(
  events: readonly ReplayQueueEvent[]
): readonly QueueTrelloCard[] {
  const cards = new Map<string, QueueTrelloCard>();
  for (const event of events) {
    if (event.connector !== 'trello') continue;
    const metadata = event.metadata ?? {};
    // The Trello import keeps the API action under data (card, list, listBefore/listAfter).
    const data =
      metadata.data !== null && typeof metadata.data === 'object'
        ? (metadata.data as Record<string, unknown>)
        : {};
    const nameOf = (value: unknown): string | null =>
      value !== null && typeof value === 'object'
        ? text((value as Record<string, unknown>).name)
        : null;
    const cardId = text(metadata.cardId);
    const name = nameOf(data.card);
    if (cardId === null || name === null) continue;
    const current = cards.get(cardId);
    const list = nameOf(data.listAfter) ?? nameOf(data.list) ?? nameOf(metadata.list);
    if (current === undefined) {
      cards.set(cardId, {
        cardId,
        name,
        firstActivityMs: event.sourceAtMs,
        lastActivityMs: event.sourceAtMs,
        list,
        listHistory: list === null ? [] : [list],
      });
      continue;
    }
    cards.set(cardId, {
      ...current,
      lastActivityMs: Math.max(current.lastActivityMs, event.sourceAtMs),
      list: list ?? current.list,
      listHistory:
        list === null || current.listHistory.at(-1) === list
          ? current.listHistory
          : [...current.listHistory, list],
    });
  }
  return [...cards.values()];
}

export async function buildWindowQueue(input: WindowQueueInput): Promise<WindowQueue> {
  assertWindow(input.startMs, input.endMs);
  const events = normalizeEvents(input.events);
  const lines = Object.freeze(events.map(toLine));
  const cards = input.trelloCards.length > 0 ? input.trelloCards : trelloCardsFromEvents(events);
  const vector = vectorCache(input.embedder ?? defaultEmbedder());
  const chunks = await buildChunks(events, input.jev, input.vocabulary);
  const rankedById = new Map<number, RankedChunk>();
  await pool(chunks, async (chunk) => {
    rankedById.set(chunk.id, await classifyChunk(chunk, input, cards, vector));
  });
  const ranked = chunks.map((chunk) => rankedById.get(chunk.id)!);
  const a = new Map<string, QueueAGroup>();
  const b: QueueBEntry[] = [];
  const c: QueueCEntry[] = [];
  const unresolved: QueueUnresolvedEntry[] = [];
  for (const item of ranked) {
    const top = item.ranked[0];
    if (item.relevance < MEDIUM_CONFIDENCE) {
      unresolved.push({
        relevance: item.relevance,
        reason: 'low relevance confidence',
        lines: item.chunk.lines,
      });
    } else if (top === undefined || top.confidence < MEDIUM_CONFIDENCE) {
      c.push({
        relevance: item.relevance,
        candidates: item.ranked.slice(0, 2),
        lines: item.chunk.lines,
      });
    } else if (top.confidence >= HIGH_CONFIDENCE) {
      const existing = a.get(top.candidate.key);
      a.set(top.candidate.key, {
        candidate: top,
        relevance: Math.max(existing?.relevance ?? 0, item.relevance),
        lines: [...(existing?.lines ?? []), ...item.chunk.lines],
      });
    } else {
      b.push({
        relevance: item.relevance,
        candidates: item.ranked.slice(0, 2),
        lines: item.chunk.lines,
      });
    }
  }
  const duplicates = await duplicatePairs(input, vector, allObservationRefs(events));
  return Object.freeze({
    window: { startMs: input.startMs, endMs: input.endMs },
    lines,
    sections: {
      a: Object.freeze([...a.values()]),
      b: Object.freeze(b),
      c: Object.freeze(c),
      // Suspected means Jev put the pair in the middle band or higher, the same cut as A/B;
      // a pair it judged different is not material for the agent (111 pairs × every window
      // ref reached 1.3M characters on 9/8 and exceeded the model input).
      suspectedDuplicates: Object.freeze(
        duplicates.filter((pair) => pair.confidence >= MEDIUM_CONFIDENCE)
      ),
      unresolved: Object.freeze(unresolved),
    },
  });
}
