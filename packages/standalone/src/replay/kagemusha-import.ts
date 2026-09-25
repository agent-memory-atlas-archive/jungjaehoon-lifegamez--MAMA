import { readFileSync } from 'node:fs';

import Database from '../sqlite.js';
import type { SQLiteDatabase } from '../sqlite.js';
import type { NormalizedItem, RawIndexSink, RawStore } from '../storage/source-archive.js';
import {
  assertRawProjectionQueuesEmpty,
  drainRawProjections,
  writeImportManifest,
} from './import-manifest.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DIRECT_ORIGINS = new Set(['slack', 'chatwork']);
const KAGEMUSHA_ORIGINS = new Set(['kakao', 'line', 'telegram', 'airbnb']);

interface KagemushaMessageRow {
  id: number | string;
  channel: string;
  channel_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: number | string;
}

interface DirectMapping {
  connector: 'slack' | 'chatwork';
  canonicalChannel: string;
}

export interface KagemushaImportOptions {
  sourceDbPath: string;
  connectorsConfigPath: string;
  rawStore: RawStore;
  rawIndexSink: RawIndexSink;
  fromMs?: number;
  untilMs?: number;
  observedAtMs?: number;
  pageSize?: number;
  manifestPath?: string;
}

export interface KagemushaImportResult {
  importedCount: number;
  importedByOrigin: Record<string, number>;
  countsByOriginDay: Record<string, Record<string, number>>;
  unmappedByOrigin: Record<string, number>;
  fromMs: number;
  untilMs: number;
  maxSourceAtMs: number | null;
  projectedCount: number;
  pendingProjectionCount: number;
}

function epochMs(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Kagemusha ${field} must be a nonnegative epoch timestamp`);
  }
  return parsed;
}

function countUp(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function originDay(timestampMs: number): string {
  return new Date(timestampMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function addOriginDay(
  counts: Record<string, Record<string, number>>,
  origin: string,
  timestampMs: number
): void {
  const days = (counts[origin] ??= {});
  countUp(days, originDay(timestampMs));
}

function loadDirectMappings(path: string): Map<string, DirectMapping> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Replay connector configuration is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Replay connector configuration must contain an object');
  }
  const result = new Map<string, DirectMapping>();
  for (const connector of ['slack', 'chatwork'] as const) {
    const connectorConfig = (parsed as Record<string, unknown>)[connector];
    const channels =
      connectorConfig && typeof connectorConfig === 'object' && !Array.isArray(connectorConfig)
        ? (connectorConfig as Record<string, unknown>).channels
        : undefined;
    if (!channels || typeof channels !== 'object' || Array.isArray(channels)) continue;
    for (const [canonicalChannel, value] of Object.entries(channels)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Replay mapping for ${connector} channel is not an object`);
      }
      const config = value as Record<string, unknown>;
      if (config.role === 'ignore') continue;
      const field = connector === 'slack' ? 'kagemusha_channel_id' : 'kagemusha_room_id';
      const mapped = config[field];
      if (mapped === undefined) continue;
      const mappedText =
        typeof mapped === 'string'
          ? mapped.trim()
          : typeof mapped === 'number' && Number.isSafeInteger(mapped) && mapped >= 0
            ? String(mapped)
            : '';
      if (mappedText === '') {
        throw new Error(
          `Replay mapping ${connector}.${field} must be text or a nonnegative integer`
        );
      }
      for (const sourceIdentity of new Set([mappedText, `${connector}:${mappedText}`])) {
        const identity = `${connector}\0${sourceIdentity}`;
        if (result.has(identity)) {
          throw new Error(`Replay mapping ${connector}.${field} is ambiguous`);
        }
        result.set(identity, { connector, canonicalChannel });
      }
    }
  }
  return result;
}

function canonicalKagemushaChannel(origin: string, channelId: string): string {
  const prefix = `${origin}:`;
  const channel = channelId.startsWith(prefix) ? channelId.slice(prefix.length) : channelId;
  if (channel.trim() === '') throw new Error('Kagemusha channel id has no channel component');
  return `kagemusha:${origin}:${channel}`;
}

function messageIdentity(row: KagemushaMessageRow): string {
  return `kagemusha:${row.channel}:${row.channel_id}:${String(row.id)}`;
}

function itemForRow(
  row: KagemushaMessageRow,
  mapping: DirectMapping | undefined
): NormalizedItem | null {
  const origin = row.channel.trim();
  let connector: string;
  let channel: string;
  if (DIRECT_ORIGINS.has(origin)) {
    if (!mapping) return null;
    connector = mapping.connector;
    channel = mapping.canonicalChannel;
  } else if (KAGEMUSHA_ORIGINS.has(origin)) {
    connector = 'kagemusha';
    channel = canonicalKagemushaChannel(origin, row.channel_id);
  } else {
    return null;
  }
  const sourceId = messageIdentity(row);
  return {
    source: connector,
    sourceId,
    sourceEntityId: sourceId,
    channel,
    author: row.user_id,
    content: row.content,
    timestamp: new Date(epochMs(row.created_at, 'created_at')),
    type: 'message',
    observedAt: undefined,
    metadata: {
      originalPlatform: origin,
      originalChannel: row.channel_id,
      kagemushaMessageId: String(row.id),
      role: row.role,
    },
  };
}

export function openKagemushaReadOnly(path: string): SQLiteDatabase {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function importFence(
  db: SQLiteDatabase,
  fromMs: number,
  requestedUntilMs: number | undefined
): { untilMs: number; maxSourceAtMs: number | null } {
  if (requestedUntilMs !== undefined) {
    if (!Number.isSafeInteger(requestedUntilMs) || requestedUntilMs < fromMs) {
      throw new Error('Kagemusha import untilMs must be a nonnegative time after fromMs');
    }
    const row = db
      .prepare(
        `SELECT MAX(created_at) AS max_created_at
           FROM channel_messages
          WHERE role = 'user' AND created_at >= ? AND created_at < ?`
      )
      .get(fromMs, requestedUntilMs) as { max_created_at: number | null };
    return { untilMs: requestedUntilMs, maxSourceAtMs: row.max_created_at ?? null };
  }
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS max_created_at
         FROM channel_messages
        WHERE role = 'user' AND created_at >= ?`
    )
    .get(fromMs) as { max_created_at: number | null };
  const maxSourceAtMs = row.max_created_at === null ? null : epochMs(row.max_created_at, 'fence');
  return {
    untilMs: maxSourceAtMs === null ? fromMs : maxSourceAtMs + 1,
    maxSourceAtMs,
  };
}

export async function importKagemushaRows(
  options: KagemushaImportOptions
): Promise<KagemushaImportResult> {
  const fromMs = options.fromMs ?? Date.parse('2026-09-01T00:00:00.000+09:00');
  if (!Number.isSafeInteger(fromMs) || fromMs < 0) {
    throw new Error('Kagemusha import fromMs must be a nonnegative epoch timestamp');
  }
  const pageSize = options.pageSize ?? 1_000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error('Kagemusha import pageSize must be an integer from 1 to 1000');
  }
  const observedAtMs = options.observedAtMs ?? Date.now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new Error('Kagemusha import observedAtMs must be a nonnegative epoch timestamp');
  }
  const mappings = loadDirectMappings(options.connectorsConfigPath);
  assertRawProjectionQueuesEmpty(options.rawStore);
  const db = openKagemushaReadOnly(options.sourceDbPath);
  const beforeCounts = new Map(
    options.rawStore
      .listConnectorNames()
      .map((connector) => [connector, options.rawStore.count(connector)] as const)
  );
  const importedByOrigin: Record<string, number> = {};
  const countsByOriginDay: Record<string, Record<string, number>> = {};
  const unmappedByOrigin: Record<string, number> = {};
  let afterCreatedAt = fromMs - 1;
  let afterId = 0;
  const fence = importFence(db, fromMs, options.untilMs);
  try {
    let keepPaging = true;
    while (keepPaging) {
      const rows = db
        .prepare(
          `SELECT id, channel, channel_id, user_id, role, content, created_at
             FROM channel_messages
            WHERE role = 'user'
              AND created_at >= ?
              AND created_at < ?
              AND (created_at > ? OR (created_at = ? AND id > ?))
            ORDER BY created_at ASC, id ASC
            LIMIT ?`
        )
        .all(
          fromMs,
          fence.untilMs,
          afterCreatedAt,
          afterCreatedAt,
          afterId,
          pageSize
        ) as KagemushaMessageRow[];
      if (rows.length === 0) {
        keepPaging = false;
        continue;
      }
      const batches = new Map<string, NormalizedItem[]>();
      for (const row of rows) {
        const origin = row.channel.trim();
        const mapping = DIRECT_ORIGINS.has(origin)
          ? mappings.get(`${origin}\0${row.channel_id}`)
          : undefined;
        const item = itemForRow(row, mapping);
        if (!item) {
          countUp(unmappedByOrigin, origin);
          continue;
        }
        item.observedAt = observedAtMs;
        const batch = batches.get(item.source) ?? [];
        batch.push(item);
        batches.set(item.source, batch);
        countUp(importedByOrigin, origin);
        addOriginDay(countsByOriginDay, origin, item.timestamp.getTime());
      }
      for (const [connector, items] of batches) options.rawStore.save(connector, items);
      const last = rows[rows.length - 1]!;
      afterCreatedAt = epochMs(last.created_at, 'created_at');
      afterId = Number(last.id);
      if (!Number.isSafeInteger(afterId) || afterId < 0)
        throw new Error('Kagemusha row id is invalid');
    }
  } finally {
    db.close();
  }
  const projectedCount = await drainRawProjections(options.rawStore, options.rawIndexSink);
  const afterCounts = options.rawStore
    .listConnectorNames()
    .reduce((total, connector) => total + options.rawStore.count(connector), 0);
  const beforeTotal = [...beforeCounts.values()].reduce((total, count) => total + count, 0);
  const pendingProjectionCount = options.rawStore
    .listConnectorNames()
    .reduce((total, connector) => total + options.rawStore.pendingProjectionCount(connector), 0);
  if (pendingProjectionCount !== 0) {
    throw new Error(`Kagemusha import left ${pendingProjectionCount} raw projections pending`);
  }
  const result = {
    importedCount: afterCounts - beforeTotal,
    importedByOrigin,
    countsByOriginDay,
    unmappedByOrigin,
    fromMs,
    untilMs: fence.untilMs,
    maxSourceAtMs: fence.maxSourceAtMs,
    projectedCount,
    pendingProjectionCount,
  };
  if (options.manifestPath !== undefined) {
    writeImportManifest(options.manifestPath, {
      fromMs,
      untilMs: fence.untilMs,
      maxSourceAtMs: fence.maxSourceAtMs,
      countsByOriginDay,
      rawObservationCount: result.importedCount,
      indexCount: projectedCount,
      pendingProjectionCount,
      unmappedByOrigin,
    });
  }
  return result;
}
