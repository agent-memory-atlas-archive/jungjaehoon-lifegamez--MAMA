import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type {
  SourceDelta,
  SourceObservationRef,
} from '../connectors/framework/polling-scheduler.js';
import Database from '../sqlite.js';

export const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
export const REPLAY_WINDOW_SIZE_MS = 12 * 60 * 60 * 1_000;
export const REPLAY_REFERENCE_CAP = 500;

export interface ReplaySourceEvent {
  readonly connector: string;
  readonly sourceId: string;
  readonly observationRef: string;
  readonly channelKey: string;
  readonly sourceAtMs: number;
  readonly rawRowId: number;
  readonly observedAtMs?: number;
  readonly sourceEntityId?: string;
  readonly contentHash?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface ReplayWindow {
  readonly startMs: number;
  readonly endMs: number;
}

interface ReplayIndexRow {
  connector: string;
  source_id: string;
  observation_ref: string | null;
  channel_key: string | null;
  source_at_ms: number;
  raw_row_id: number;
  observed_at_ms: number | null;
  source_entity_id: string | null;
  metadata_json: string | null;
  content_hash: Buffer | Uint8Array | string | null;
}

type ReplayCatalogAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface ReplaySourceReadOptions {
  rawRoot?: string;
}

function assertEpochMs(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative epoch-millisecond integer`);
  }
}

function assertRange(fromMs: number, untilMs: number): void {
  assertEpochMs(fromMs, 'fromMs');
  assertEpochMs(untilMs, 'untilMs');
  if (untilMs < fromMs) throw new Error('untilMs must not precede fromMs');
}

function compareEvents(left: ReplaySourceEvent, right: ReplaySourceEvent): number {
  return (
    left.sourceAtMs - right.sourceAtMs ||
    left.connector.localeCompare(right.connector) ||
    left.channelKey.localeCompare(right.channelKey) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.rawRowId - right.rawRowId
  );
}

function channelGroupKey(event: ReplaySourceEvent): string {
  return `${event.connector}\0${event.channelKey}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Replay source metadata is malformed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Replay source metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function hashText(value: Buffer | Uint8Array | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return Buffer.from(value).toString('hex');
}

function rowToEvent(row: ReplayIndexRow): ReplaySourceEvent {
  if (typeof row.connector !== 'string' || row.connector.trim() === '') {
    throw new Error('Replay source connector is missing');
  }
  if (typeof row.source_id !== 'string' || row.source_id.trim() === '') {
    throw new Error('Replay source id is missing');
  }
  if (typeof row.observation_ref !== 'string' || row.observation_ref.trim() === '') {
    throw new Error(`Replay source projection is missing for ${row.connector}:${row.source_id}`);
  }
  if (typeof row.channel_key !== 'string' || row.channel_key.trim() === '') {
    throw new Error(`Replay source channel is missing for ${row.connector}:${row.source_id}`);
  }
  assertEpochMs(row.source_at_ms, 'sourceAtMs');
  if (!Number.isSafeInteger(row.raw_row_id) || row.raw_row_id < 1) {
    throw new Error(`Replay source row id is invalid for ${row.connector}:${row.source_id}`);
  }
  if (row.observed_at_ms !== null) assertEpochMs(row.observed_at_ms, 'observedAtMs');
  const metadata = parseMetadata(row.metadata_json);
  const event: ReplaySourceEvent = {
    connector: row.connector,
    sourceId: row.source_id,
    observationRef: row.observation_ref,
    channelKey: row.channel_key,
    sourceAtMs: row.source_at_ms,
    rawRowId: row.raw_row_id,
    ...(row.observed_at_ms === null ? {} : { observedAtMs: row.observed_at_ms }),
    ...(row.source_entity_id === null ? {} : { sourceEntityId: row.source_entity_id }),
    contentHash: hashText(row.content_hash),
    ...(metadata === undefined ? {} : { metadata }),
  };
  return Object.freeze(event);
}

/** Read the immutable observation projections produced for every imported raw store. */
export function readReplaySourceEvents(
  adapter: ReplayCatalogAdapter,
  fromMs: number,
  untilMs: number,
  options: ReplaySourceReadOptions = {}
): readonly ReplaySourceEvent[] {
  assertRange(fromMs, untilMs);
  const rows = adapter
    .prepare(
      `SELECT e.source_connector AS connector,
              e.source_id,
              e.current_observation_id AS observation_ref,
              e.channel AS channel_key,
              COALESCE(e.event_datetime, e.source_timestamp_ms) AS source_at_ms,
              COALESCE(e.operator_ingest_seq, e.rowid) AS raw_row_id,
              o.observed_at AS observed_at_ms,
              e.source_entity_id,
              e.metadata_json,
              e.content_hash
         FROM connector_event_index e
         LEFT JOIN observation_versions o ON o.observation_id = e.current_observation_id
        WHERE COALESCE(e.event_datetime, e.source_timestamp_ms) >= ?
          AND COALESCE(e.event_datetime, e.source_timestamp_ms) < ?
        ORDER BY source_at_ms ASC, connector ASC, channel_key ASC, e.source_id ASC, raw_row_id ASC`
    )
    .all(fromMs, untilMs) as ReplayIndexRow[];
  const rawRowIds =
    options.rawRoot === undefined ? null : readRawRowIds(options.rawRoot, fromMs, untilMs);
  return Object.freeze(
    rows.map((row) => {
      if (rawRowIds !== null) {
        const rawRowId = rawRowIds.get(`${row.connector}\0${row.source_id}`);
        if (rawRowId === undefined) {
          throw new Error(`Replay raw store row is missing for ${row.connector}:${row.source_id}`);
        }
        return rowToEvent({ ...row, raw_row_id: rawRowId });
      }
      return rowToEvent(row);
    })
  );
}

function readRawRowIds(rawRoot: string, fromMs: number, untilMs: number): Map<string, number> {
  if (!existsSync(rawRoot)) throw new Error('Replay raw root does not exist');
  const ids = new Map<string, number>();
  const connectors = readdirSync(rawRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const connector of connectors) {
    const path = join(rawRoot, connector, 'raw.db');
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare('SELECT id, source_id FROM raw_items WHERE timestamp >= ? AND timestamp < ?')
        .all(fromMs, untilMs) as Array<{ id: number; source_id: string }>;
      for (const row of rows) {
        if (!Number.isSafeInteger(row.id) || row.id < 1 || typeof row.source_id !== 'string') {
          throw new Error(`Replay raw row identity is invalid for ${connector}`);
        }
        const key = `${connector}\0${row.source_id}`;
        if (ids.has(key))
          throw new Error(
            `Replay raw row identity is duplicated for ${connector}:${row.source_id}`
          );
        ids.set(key, row.id);
      }
    } finally {
      db.close();
    }
  }
  return ids;
}

/**
 * The catalog is deliberately metadata-only. Bodies stay in the connector raw
 * stores and reach the owner only through the normal source.read action.
 */
export class ReplaySourceCatalog {
  private readonly events: readonly ReplaySourceEvent[];

  constructor(events: readonly ReplaySourceEvent[]) {
    const copy = events.map((event) => {
      if (
        event.connector.trim() === '' ||
        event.sourceId.trim() === '' ||
        event.observationRef.trim() === '' ||
        event.channelKey.trim() === ''
      ) {
        throw new Error('Replay source event identity must be nonblank');
      }
      assertEpochMs(event.sourceAtMs, 'sourceAtMs');
      if (!Number.isSafeInteger(event.rawRowId) || event.rawRowId < 1) {
        throw new Error('rawRowId must be a positive safe integer');
      }
      if (event.observedAtMs !== undefined) assertEpochMs(event.observedAtMs, 'observedAtMs');
      return Object.freeze({ ...event });
    });
    this.events = Object.freeze(copy.sort(compareEvents));
  }

  allEvents(): readonly ReplaySourceEvent[] {
    return this.events;
  }

  eventsForWindow(startMs: number, endMs: number): readonly ReplaySourceEvent[] {
    assertRange(startMs, endMs);
    return this.events.filter((event) => event.sourceAtMs >= startMs && event.sourceAtMs < endMs);
  }

  windows(fromMs: number, untilMs: number): readonly ReplayWindow[] {
    assertRange(fromMs, untilMs);
    const result: ReplayWindow[] = [];
    for (let startMs = fromMs; startMs < untilMs; startMs += REPLAY_WINDOW_SIZE_MS) {
      result.push({ startMs, endMs: Math.min(startMs + REPLAY_WINDOW_SIZE_MS, untilMs) });
    }
    return Object.freeze(result);
  }

  deltasForWindow(runId: string, startMs: number, endMs: number): readonly SourceDelta[] {
    if (runId.trim() === '') throw new Error('Replay runId is required');
    const events = this.eventsForWindow(startMs, endMs);
    const groups = new Map<string, ReplaySourceEvent[]>();
    for (const event of events) {
      const key = channelGroupKey(event);
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
    const orderedGroups = [...groups.values()].sort((left, right) => {
      const first = [...left].sort(compareEvents)[0]!;
      const second = [...right].sort(compareEvents)[0]!;
      return (
        first.sourceAtMs - second.sourceAtMs ||
        channelGroupKey(first).localeCompare(channelGroupKey(second))
      );
    });
    const windowId = `window:${startMs}:${endMs}`;
    return Object.freeze(
      orderedGroups.map((group) => {
        const ordered = [...group].sort(compareEvents);
        const refs: readonly SourceObservationRef[] = Object.freeze(
          ordered.map((event) => ({
            connector: event.connector,
            observationRef: event.observationRef,
            sourceId: event.sourceId,
            sourceEntityId: event.sourceEntityId ?? event.sourceId,
            sourceAt: iso(event.sourceAtMs),
            observedAt: iso(event.observedAtMs ?? event.sourceAtMs),
            contentHash: event.contentHash ?? null,
            ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
          }))
        );
        const first = ordered[0]!;
        const occurredAt = ordered[ordered.length - 1]!.sourceAtMs;
        return {
          kind: 'source_delta' as const,
          collector: first.connector,
          channel: first.channelKey,
          coalesceKey: `source:${first.connector}:${first.channelKey}:${windowId}`,
          refs,
          preview: Object.freeze([
            `replay window=${windowId}`,
            `source refs=${String(refs.length)}`,
            `source first=${iso(first.sourceAtMs)}`,
            `source last=${iso(occurredAt)}`,
          ]),
          occurredAt,
          replay: {
            runId,
            windowId,
            windowStartMs: startMs,
            windowEndMs: endMs,
          },
        } satisfies SourceDelta;
      })
    );
  }
}

export function createReplaySourceCatalog(
  adapter: ReplayCatalogAdapter,
  fromMs: number,
  untilMs: number,
  options: ReplaySourceReadOptions = {}
): ReplaySourceCatalog {
  return new ReplaySourceCatalog(readReplaySourceEvents(adapter, fromMs, untilMs, options));
}
