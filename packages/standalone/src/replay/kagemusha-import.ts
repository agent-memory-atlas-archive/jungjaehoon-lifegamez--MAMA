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

interface FeedbackAuditRow {
  id: number | string;
  code: string;
  created_at: number | string;
}

export interface FeedbackObservationFields {
  translatedText: string;
  rawBody?: string;
  chatworkRoomId?: string;
  slackFileIds?: string[];
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

function matchingClose(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Feedback code has an unterminated ${open}${close} expression`);
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail !== '') parts.push(tail);
  return parts;
}

function objectProperties(source: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const part of splitTopLevel(source)) {
    const colon = part.indexOf(':');
    if (colon > 0) {
      const key = part
        .slice(0, colon)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (/^[A-Za-z_$][\w$]*$/.test(key)) properties.set(key, part.slice(colon + 1).trim());
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(part)) properties.set(part, part);
  }
  return properties;
}

function assignmentExpressions(source: string): Map<string, string> {
  const assignments = new Map<string, string>();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!;
    const start = (match.index ?? 0) + match[0].length;
    let quote: string | null = null;
    let escaped = false;
    let depth = 0;
    let end = source.length;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]!;
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if ('([{'.includes(char)) depth += 1;
      if (')]}'.includes(char)) depth -= 1;
      if (depth === 0 && (char === ';' || char === '\n')) {
        end = index;
        break;
      }
    }
    assignments.set(name, source.slice(start, end).trim());
  }
  return assignments;
}

function decodeString(
  expression: string,
  assignments: Map<string, string>,
  depth = 0
): string | null {
  if (depth > 8) throw new Error('Feedback code variable indirection is too deep');
  const value = expression.trim();
  if (value.length < 2) {
    const assigned = assignments.get(value);
    return assigned === undefined ? null : decodeString(assigned, assignments, depth + 1);
  }
  const quote = value[0];
  if (quote !== value[value.length - 1] || !['"', "'", '`'].includes(quote)) {
    const assigned = assignments.get(value);
    return assigned === undefined ? null : decodeString(assigned, assignments, depth + 1);
  }
  const body = value
    .slice(1, -1)
    .replace(
      /\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|.)/g,
      (_match, unicodePoint: string, unicodeBraced?: string, unicode?: string, hex?: string) => {
        if (unicodeBraced) return String.fromCodePoint(Number.parseInt(unicodeBraced, 16));
        if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
        if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
        return (
          ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' } as Record<string, string>)[
            unicodePoint
          ] ?? unicodePoint
        );
      }
    );
  return body.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_match, name: string) => {
    return decodeString(assignments.get(name) ?? name, assignments, depth + 1) ?? `\${${name}}`;
  });
}

function valueExpression(
  properties: Map<string, string>,
  name: string,
  assignments: Map<string, string>
): string | undefined {
  return properties.get(name) ?? assignments.get(name);
}

function extractForwardFeedbackObject(code: string): Map<string, string> | null {
  const calls = /\bforward_feedback\s*\(/g;
  for (const match of code.matchAll(calls)) {
    const start = (match.index ?? 0) + match[0].length;
    const open = code.slice(start).search(/\S/);
    if (open < 0 || code[start + open] !== '{') continue;
    const objectStart = start + open;
    const objectEnd = matchingClose(code, objectStart, '{', '}');
    const properties = objectProperties(code.slice(objectStart + 1, objectEnd));
    if (properties.has('translatedText') || properties.has('text')) return properties;
  }
  return null;
}

export function parseFeedbackAuditCode(code: string): FeedbackObservationFields | null {
  const assignments = assignmentExpressions(code);
  const properties = extractForwardFeedbackObject(code);
  if (!properties) return null;
  const translatedExpression =
    valueExpression(properties, 'translatedText', assignments) ??
    valueExpression(properties, 'text', assignments);
  const translatedText =
    translatedExpression === undefined ? null : decodeString(translatedExpression, assignments);
  if (translatedText === null || translatedText.trim() === '') return null;
  const rawExpression = valueExpression(properties, 'rawBody', assignments);
  const rawBody =
    rawExpression === undefined
      ? undefined
      : (decodeString(rawExpression, assignments) ?? undefined);
  const chatworkExpression = valueExpression(properties, 'chatworkRoomId', assignments);
  const chatworkRoomId =
    chatworkExpression === undefined
      ? undefined
      : /^\d+$/.test(chatworkExpression.trim())
        ? chatworkExpression.trim()
        : (decodeString(chatworkExpression, assignments) ?? undefined);
  const slackExpression = valueExpression(properties, 'slackFileIds', assignments);
  let slackFileIds: string[] | undefined;
  if (slackExpression !== undefined) {
    const array = slackExpression.trim();
    if (array.startsWith('[') && array.endsWith(']')) {
      slackFileIds = splitTopLevel(array.slice(1, -1))
        .map((item) => decodeString(item, assignments))
        .filter((item): item is string => item !== null && item.trim() !== '');
    }
  }
  return {
    translatedText,
    ...(rawBody === undefined ? {} : { rawBody }),
    ...(chatworkRoomId === undefined ? {} : { chatworkRoomId }),
    ...(slackFileIds === undefined || slackFileIds.length === 0 ? {} : { slackFileIds }),
  };
}

function feedbackItem(row: FeedbackAuditRow, fields: FeedbackObservationFields): NormalizedItem {
  const sourceId = `kagemusha:feedback:${String(row.id)}`;
  const attachmentChannel =
    fields.chatworkRoomId === undefined && fields.slackFileIds === undefined
      ? 'kagemusha:feedback'
      : fields.chatworkRoomId === undefined
        ? `kagemusha:feedback:slack:${fields.slackFileIds!.join(',')}`
        : `kagemusha:feedback:chatwork:${fields.chatworkRoomId}`;
  const content =
    fields.rawBody === undefined
      ? fields.translatedText
      : `${fields.translatedText}\n\n${fields.rawBody}`;
  return {
    source: 'kagemusha',
    sourceId,
    sourceEntityId: sourceId,
    channel: attachmentChannel,
    author: 'feedback',
    content,
    timestamp: new Date(epochMs(row.created_at, 'feedback.created_at')),
    type: 'message',
    metadata: {
      originalPlatform: 'feedback',
      sourceType: 'feedback',
      codeActAuditId: String(row.id),
      ...(fields.chatworkRoomId === undefined ? {} : { chatworkRoomId: fields.chatworkRoomId }),
      ...(fields.slackFileIds === undefined ? {} : { slackFileIds: fields.slackFileIds }),
    },
  };
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
        `SELECT MAX(created_at) AS max_created_at FROM (
           SELECT created_at FROM channel_messages
            WHERE role = 'user' AND created_at >= ? AND created_at < ?
           UNION ALL
           SELECT created_at FROM code_act_audit
            WHERE code LIKE '%forward_feedback(%' AND created_at >= ? AND created_at < ?
         )`
      )
      .get(fromMs, requestedUntilMs, fromMs, requestedUntilMs) as { max_created_at: number | null };
    return { untilMs: requestedUntilMs, maxSourceAtMs: row.max_created_at ?? null };
  }
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS max_created_at FROM (
         SELECT created_at FROM channel_messages
          WHERE role = 'user' AND created_at >= ?
         UNION ALL
         SELECT created_at FROM code_act_audit
          WHERE code LIKE '%forward_feedback(%' AND created_at >= ?
       )`
    )
    .get(fromMs, fromMs) as { max_created_at: number | null };
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
  let afterFeedbackCreatedAt = fromMs - 1;
  let afterFeedbackId = 0;
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
      for (const [connector, items] of batches)
        options.rawStore.save(connector, items, { collectOnly: true });
      const last = rows[rows.length - 1]!;
      afterCreatedAt = epochMs(last.created_at, 'created_at');
      afterId = Number(last.id);
      if (!Number.isSafeInteger(afterId) || afterId < 0)
        throw new Error('Kagemusha row id is invalid');
    }
    let keepFeedbackPaging = true;
    while (keepFeedbackPaging) {
      const rows = db
        .prepare(
          `SELECT id, code, created_at
             FROM code_act_audit
            WHERE code LIKE '%forward_feedback(%'
              AND created_at >= ?
              AND created_at < ?
              AND (created_at > ? OR (created_at = ? AND id > ?))
            ORDER BY created_at ASC, id ASC
            LIMIT ?`
        )
        .all(
          fromMs,
          fence.untilMs,
          afterFeedbackCreatedAt,
          afterFeedbackCreatedAt,
          afterFeedbackId,
          pageSize
        ) as FeedbackAuditRow[];
      if (rows.length === 0) {
        keepFeedbackPaging = false;
        continue;
      }
      const items: NormalizedItem[] = [];
      for (const row of rows) {
        const fields = parseFeedbackAuditCode(row.code);
        if (fields === null) {
          countUp(unmappedByOrigin, 'feedback');
          continue;
        }
        const item = feedbackItem(row, fields);
        item.observedAt = observedAtMs;
        items.push(item);
        countUp(importedByOrigin, 'feedback');
        addOriginDay(countsByOriginDay, 'feedback', item.timestamp.getTime());
      }
      if (items.length > 0) options.rawStore.save('kagemusha', items, { collectOnly: true });
      const last = rows[rows.length - 1]!;
      afterFeedbackCreatedAt = epochMs(last.created_at, 'feedback.created_at');
      afterFeedbackId = Number(last.id);
      if (!Number.isSafeInteger(afterFeedbackId) || afterFeedbackId < 0) {
        throw new Error('Feedback audit row id is invalid');
      }
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
