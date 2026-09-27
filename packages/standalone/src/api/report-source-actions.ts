import type { ActionRegistration } from '@jungjaehoon/mama-core';
import type { ActionContext } from '@jungjaehoon/mama-core';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

type Access = ActionContext['access'];
type Row = Record<string, unknown>;
type ReportReadPorts = { adapter: Pick<DatabaseAdapter, 'prepare'>; ownerPrincipalId: string };

function grantChannels(
  access: Access,
  connector: string,
  ownerPrincipalId: string
): string[] | null {
  if (!access.connectors?.includes(connector)) return [];
  if (access.principalId === ownerPrincipalId) return null;
  return [
    ...new Set((access.channels?.[connector] ?? []).filter((channel) => channel.trim() !== '')),
  ];
}

function allowedRows(rows: Row[], access: Access, ownerPrincipalId: string): Row[] {
  return rows.filter((row) => {
    const connector = String(row.source_connector);
    const channels = grantChannels(access, connector, ownerPrincipalId);
    return channels !== null && channels.length === 0
      ? false
      : channels === null || channels.includes(String(row.channel ?? ''));
  });
}

function visibleConnectorFilter(
  connectors: readonly string[],
  access: Access,
  ownerPrincipalId: string
): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const connector of connectors) {
    const wide = access.principalId === ownerPrincipalId;
    if (wide) {
      clauses.push('source_connector = ?');
      params.push(connector);
      continue;
    }
    const granted = access.channels?.[connector] ?? [];
    const readGranted = granted;
    if (readGranted.length === 0) continue;
    clauses.push(`(source_connector = ? AND channel IN (${readGranted.map(() => '?').join(',')}))`);
    params.push(connector, ...readGranted);
  }
  return {
    sql: clauses.length ? clauses.map((clause) => `(${clause})`).join(' OR ') : '0',
    params,
  };
}

function sinceTime(value: unknown, now: number): number {
  if (value === undefined) return now - 24 * 60 * 60 * 1_000;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const duration = /^(\d+)\s*(h|d) ago$/i.exec(value.trim());
    if (duration)
      return (
        now - Number(duration[1]) * (duration[2]!.toLowerCase() === 'h' ? 3_600_000 : 86_400_000)
      );
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(
    'source.recent since must be epoch milliseconds, an ISO time, or a duration such as "24h ago"'
  );
}

function decodeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Stored event metadata is malformed');
  return parsed as Record<string, unknown>;
}

function recentAction(ports: ReportReadPorts): ActionRegistration {
  return {
    contract: {
      name: 'source.recent',
      summary:
        'Read recent changes from every granted stored source, grouped by channel, with collection failures visible.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          since: {
            description:
              'Start time as epoch milliseconds, timezone-aware ISO time, or duration such as "24h ago". Defaults to 24 hours.',
            oneOf: [
              { type: 'integer', minimum: 0 },
              { type: 'string', minLength: 1 },
            ],
          },
          perChannel: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Recent source changes per channel; defaults to 5.',
          },
          cap: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description:
              'Maximum recent changes scanned; exceeding it fails with a request to narrow the time window.',
          },
        },
      },
      examples: [{ title: 'Recent source changes', input: { since: '24h ago', perChannel: 5 } }],
    },
    exec: (input, context) => {
      const values = input as Record<string, unknown>;
      const now = Date.now();
      const since = sinceTime(values.since, now);
      const perChannel = values.perChannel === undefined ? 5 : (values.perChannel as number);
      const cap = values.cap === undefined ? 250 : (values.cap as number);
      if (!Number.isSafeInteger(perChannel) || Number(perChannel) < 1 || Number(perChannel) > 20)
        throw new Error('source.recent perChannel must be from 1 to 20');
      if (!Number.isSafeInteger(cap) || Number(cap) < 1 || Number(cap) > 500)
        throw new Error('source.recent cap must be from 1 to 500');
      const connectors = context.access.connectors ?? [];
      if (connectors.length === 0)
        throw new Error('source.recent requires at least one granted connector');
      const visibility = visibleConnectorFilter(connectors, context.access, ports.ownerPrincipalId);
      const sourceCeiling = context.readAllowance?.maxSourceMs;
      const rows = ports.adapter
        .prepare(
          `SELECT source_connector, source_id, source_entity_id, channel, author, content, source_timestamp_ms,
                current_observation_id, metadata_json
         FROM connector_event_index WHERE (${visibility.sql}) AND source_timestamp_ms >= ?
           ${sourceCeiling === undefined || sourceCeiling === null ? '' : 'AND source_timestamp_ms <= ?'}
         ORDER BY source_timestamp_ms DESC, source_id DESC LIMIT ?`
        )
        .all(
          ...visibility.params,
          since,
          ...(sourceCeiling === undefined || sourceCeiling === null ? [] : [sourceCeiling]),
          Number(cap) + 1
        ) as Row[];
      if (rows.length > Number(cap))
        throw new Error(
          `source.recent found more than ${cap} changes; narrow since or increase cap`
        );
      const visible = allowedRows(rows, context.access, ports.ownerPrincipalId);
      const groups = new Map<
        string,
        { source: string; channel: string; lines: Array<Record<string, unknown>> }
      >();
      for (const row of visible) {
        const metadata = decodeMetadata(row.metadata_json);
        const source = String(row.source_connector);
        const key = String(row.channel ?? '');
        const label =
          typeof metadata.channelName === 'string' ? metadata.channelName : key || source;
        const groupKey = `${source}\0${key}`;
        const group = groups.get(groupKey) ?? { source, channel: label, lines: [] };
        if (group.lines.length >= Number(perChannel)) continue;
        const timestamp = Number(row.source_timestamp_ms);
        if (
          typeof row.current_observation_id !== 'string' ||
          row.current_observation_id.trim() === ''
        ) {
          throw new Error('source.recent indexed change has no observation reference');
        }
        group.lines.push({
          author: row.author ?? null,
          time: new Date(timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
          text: String(row.content).slice(0, 200),
          observationRef: row.current_observation_id,
        });
        groups.set(groupKey, group);
      }
      const failures = ports.adapter
        .prepare(
          `SELECT connector_name, last_error, last_error_at FROM connector_event_index_cursors
         WHERE last_error IS NOT NULL AND connector_name IN (${connectors.map(() => '?').join(',')})`
        )
        .all(...connectors) as Row[];
      const failedConnectors = failures
        .filter((row) => {
          const grant = grantChannels(
            context.access,
            String(row.connector_name),
            ports.ownerPrincipalId
          );
          return grant === null || grant.length > 0;
        })
        .map((row) => {
          const connector = String(row.connector_name);
          const knownChannels = ports.adapter
            .prepare(
              `SELECT DISTINCT source_connector, channel, metadata_json FROM connector_event_index WHERE source_connector = ?`
            )
            .all(connector) as Row[];
          const failedChannels = [
            ...new Map(
              allowedRows(knownChannels, context.access, ports.ownerPrincipalId)
                .filter((event) => event.source_connector === connector)
                .map((event) => {
                  const metadata = decodeMetadata(event.metadata_json);
                  const key = String(event.channel ?? '');
                  return [
                    key,
                    typeof metadata.channelName === 'string' ? metadata.channelName : key,
                  ] as const;
                })
            ).values(),
          ];
          return {
            connector,
            channels: failedChannels,
            error: row.last_error,
            failedAt: row.last_error_at,
          };
        });
      return {
        since: new Date(since).toISOString(),
        cap: Number(cap),
        scanned: visible.length,
        returned: [...groups.values()].reduce((count, group) => count + group.lines.length, 0),
        channels: [...groups.values()].sort(
          (a, b) => a.source.localeCompare(b.source) || a.channel.localeCompare(b.channel)
        ),
        failedConnectors,
      };
    },
  };
}

function upcomingAction(ports: ReportReadPorts): ActionRegistration {
  return {
    contract: {
      name: 'schedule.upcoming',
      summary:
        'Read upcoming calendar and iCal events from the stored event index, including configured holiday calendars.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: {
            type: 'integer',
            minimum: 0,
            maximum: 90,
            description: 'Days ahead, default 14.',
          },
          cap: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Event cap; exceeding it fails instead of truncating.',
          },
        },
      },
      examples: [{ title: 'Next two weeks', input: { days: 14 } }],
    },
    exec: (input, context) => {
      const values = input as Record<string, unknown>;
      const days = values.days === undefined ? 14 : (values.days as number);
      const cap = values.cap === undefined ? 250 : (values.cap as number);
      if (!Number.isSafeInteger(days) || Number(days) < 0 || Number(days) > 90)
        throw new Error('schedule.upcoming days must be from 0 to 90');
      if (!Number.isSafeInteger(cap) || Number(cap) < 1 || Number(cap) > 500)
        throw new Error('schedule.upcoming cap must be from 1 to 500');
      const connectors = ['calendar', 'ical'].filter((name) =>
        context.access.connectors?.includes(name)
      );
      if (!connectors.length)
        throw new Error('schedule.upcoming requires a granted calendar or ical connector');
      const visibility = visibleConnectorFilter(connectors, context.access, ports.ownerPrincipalId);
      const raw = ports.adapter
        .prepare(
          `SELECT source_connector, source_id, source_entity_id, channel, source_timestamp_ms,
                metadata_json, current_observation_id
         FROM (SELECT e.*, ROW_NUMBER() OVER (
           PARTITION BY source_connector, COALESCE(source_entity_id, source_id)
           ORDER BY source_timestamp_ms DESC, indexed_at DESC, source_id DESC
         ) AS revision_order FROM connector_event_index e
         WHERE (${visibility.sql}))
         WHERE revision_order=1 ORDER BY source_timestamp_ms DESC`
        )
        .all(...visibility.params) as Row[];
      const visible = allowedRows(raw, context.access, ports.ownerPrincipalId);
      const now = Date.now();
      const until = now + Number(days) * 86_400_000;
      const events = visible.flatMap((row) => {
        const metadata = decodeMetadata(row.metadata_json);
        if (metadata.status === 'cancelled') return [];
        const startRaw = metadata.start ?? metadata.dtstart;
        const endRaw = metadata.end ?? metadata.dtend;
        if (typeof startRaw !== 'string' || typeof endRaw !== 'string') return [];
        const start = Date.parse(startRaw);
        const end = Date.parse(endRaw);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < now || start > until)
          return [];
        return [
          {
            source: row.source_connector,
            calendar: metadata.calendarName ?? metadata.feedName ?? row.channel,
            start: startRaw,
            end: endRaw,
            title: metadata.summary ?? '(Untitled event)',
            observationRef: row.current_observation_id,
          },
        ];
      });
      if (events.length > Number(cap))
        throw new Error(
          `schedule.upcoming found more than ${cap} events; narrow days or increase cap`
        );
      events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return { days: Number(days), cap: Number(cap), returned: events.length, events };
    },
  };
}

export function reportSourceActionRegistrations(ports: ReportReadPorts): ActionRegistration[] {
  return [recentAction(ports), upcomingAction(ports)];
}
