import type { DatabaseAdapter } from '../db-manager.js';
import {
  listActiveCorrectionsForCase,
  listActiveMembershipsForCaseChain,
  resolveCanonicalCaseChain,
} from './case-store.js';
import type {
  CaseAssemblyMembership,
  CaseMembershipSourceType,
  CaseTimelineRangeInput,
  CaseTimelineRangeItem,
  CaseTimelineRangeResult,
} from './case-types.js';

type CaseTimelineRangeAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

interface CodedError extends Error {
  code: string;
  context?: Record<string, unknown>;
}

interface RangeBounds {
  fromMs: number | null;
  toMs: number | null;
}

function codedError(code: string, message: string, context?: Record<string, unknown>): CodedError {
  const error = new Error(`${code}: ${message}`) as CodedError;
  error.code = code;
  error.context = context;
  return error;
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL placeholders for an empty list.');
  }
  return values.map(() => '?').join(', ');
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseDateBound(value: string | number | undefined, field: 'from' | 'to'): number | null {
  if (value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw codedError('case.timeline_range_invalid_date', `${field} must be a finite number.`, {
        field,
        value,
      });
    }
    return Math.floor(value);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw codedError('case.timeline_range_invalid_date', `${field} is not a valid date.`, {
      field,
      value,
    });
  }
  return parsed;
}

function parseBounds(input: CaseTimelineRangeInput): RangeBounds {
  const fromMs = parseDateBound(input.from, 'from');
  const toMs = parseDateBound(input.to, 'to');

  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw codedError('case.timeline_range_invalid_order', 'from must be before or equal to to.', {
      from: input.from,
      to: input.to,
    });
  }

  return { fromMs, toMs };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 100;
  }
  return Math.min(500, Math.max(0, Math.floor(limit)));
}

function timestampMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value);
  if (text.length === 0) {
    return null;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && /^\d+$/u.test(text)) {
    return numeric;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventDateFromMs(ms: number | null): string | null {
  if (ms === null) {
    return null;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function withinBounds(ms: number | null, bounds: RangeBounds): boolean {
  if (ms === null) {
    return bounds.fromMs === null && bounds.toMs === null;
  }
  if (bounds.fromMs !== null && ms < bounds.fromMs) {
    return false;
  }
  if (bounds.toMs !== null && ms > bounds.toMs) {
    return false;
  }
  return true;
}

function compareItemsAsc(left: CaseTimelineRangeItem, right: CaseTimelineRangeItem): number {
  const leftMs = left.event_datetime ?? Number.NEGATIVE_INFINITY;
  const rightMs = right.event_datetime ?? Number.NEGATIVE_INFINITY;

  if (leftMs !== rightMs) {
    return leftMs - rightMs;
  }

  const itemDelta = left.item_type.localeCompare(right.item_type);
  if (itemDelta !== 0) {
    return itemDelta;
  }

  const sourceTypeDelta = left.source_type.localeCompare(right.source_type);
  if (sourceTypeDelta !== 0) {
    return sourceTypeDelta;
  }

  return left.source_id.localeCompare(right.source_id);
}

/** What an observation carries when a caller asked for the source detail. */
interface ObservationEvidence {
  observation_id: string;
  source: string;
  source_id: string;
  source_type: string | null;
  source_locator: string | null;
  title: string | null;
  artifact_locator: string | null;
  artifact_title: string | null;
  body: string | null;
  source_at: number | null;
  observed_at: number;
  event_date: string | null;
}

function connectorEventSnapshot(row: ObservationEvidence | null) {
  if (!row) {
    return null;
  }

  return {
    event_index_id: row.observation_id,
    source_connector: row.source,
    source_id: row.source_id,
    source_locator: row.source_locator,
    artifact_locator: row.artifact_locator,
    title: row.title,
    content: row.body,
    event_datetime: row.source_at,
    event_date: row.event_date,
    observation_ref: row.observation_id,
  };
}

function membershipById(
  memberships: CaseAssemblyMembership[],
  sourceType: CaseMembershipSourceType
): Map<string, CaseAssemblyMembership> {
  return new Map(
    memberships
      .filter((membership) => membership.source_type === sourceType)
      .map((membership) => [membership.source_id, membership])
  );
}

function loadDecisionItems(
  adapter: CaseTimelineRangeAdapter,
  memberships: CaseAssemblyMembership[],
  bounds: RangeBounds
): CaseTimelineRangeItem[] {
  const membershipMap = membershipById(memberships, 'decision');
  const ids = Array.from(membershipMap.keys());
  if (ids.length === 0) {
    return [];
  }

  const rows = adapter
    .prepare(
      `
        SELECT id, topic, decision, summary, reasoning, confidence, event_datetime, event_date, created_at
        FROM decisions
        WHERE id IN (${placeholders(ids)})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  return rows
    .map((row): CaseTimelineRangeItem => {
      const sourceId = String(row.id);
      const membership = membershipMap.get(sourceId);
      const eventDatetime =
        timestampMs(row.event_datetime) ??
        timestampMs(row.event_date) ??
        timestampMs(row.created_at);
      return {
        item_type: 'decision',
        source_type: 'decision',
        source_id: sourceId,
        source_locator: null,
        event_datetime: eventDatetime,
        event_date: nullableString(row.event_date) ?? eventDateFromMs(eventDatetime),
        title: nullableString(row.topic),
        summary: nullableString(row.summary ?? row.decision),
        role: membership?.role ?? null,
        confidence: membership?.confidence ?? nullableNumber(row.confidence),
        membership_reason: membership?.reason ?? null,
      };
    })
    .filter((item) => withinBounds(item.event_datetime, bounds));
}

function loadEventItems(
  adapter: CaseTimelineRangeAdapter,
  memberships: CaseAssemblyMembership[],
  bounds: RangeBounds
): CaseTimelineRangeItem[] {
  const membershipMap = membershipById(memberships, 'event');
  const ids = Array.from(membershipMap.keys());
  if (ids.length === 0) {
    return [];
  }

  const rows = adapter
    .prepare(
      `
        SELECT id, event_type, role, observed_at, source_ref, summary, details, created_at
        FROM entity_timeline_events
        WHERE id IN (${placeholders(ids)})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  return rows
    .map((row): CaseTimelineRangeItem => {
      const sourceId = String(row.id);
      const membership = membershipMap.get(sourceId);
      const eventDatetime = timestampMs(row.observed_at) ?? timestampMs(row.created_at);
      return {
        item_type: 'event',
        source_type: 'event',
        source_id: sourceId,
        source_locator: nullableString(row.source_ref),
        event_datetime: eventDatetime,
        event_date: eventDateFromMs(eventDatetime),
        title: nullableString(row.event_type),
        summary: nullableString(row.summary),
        role: membership?.role ?? nullableString(row.role),
        confidence: membership?.confidence ?? null,
        membership_reason: membership?.reason ?? null,
      };
    })
    .filter((item) => withinBounds(item.event_datetime, bounds));
}

function loadObservationItems(
  adapter: CaseTimelineRangeAdapter,
  memberships: CaseAssemblyMembership[],
  bounds: RangeBounds,
  includeConnectorEnrichments: boolean
): CaseTimelineRangeItem[] {
  const membershipMap = membershipById(memberships, 'observation');
  const ids = Array.from(membershipMap.keys());
  if (ids.length === 0) {
    return [];
  }

  const rows = adapter
    .prepare(
      `
        SELECT id, surface_form, context_summary, source_connector, source_raw_record_id,
               source_locator, timestamp_observed, created_at
        FROM entity_observations
        WHERE id IN (${placeholders(ids)})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  return rows
    .map((row): CaseTimelineRangeItem => {
      const sourceId = String(row.id);
      const membership = membershipMap.get(sourceId);
      const eventDatetime = timestampMs(row.timestamp_observed) ?? timestampMs(row.created_at);
      // Same move as the artifact branch: the source detail is the observation's,
      // and reaching for the connector index made a core read depend on a package
      // three of four consumers do not install.
      const connectorEvent =
        includeConnectorEnrichments &&
        typeof row.source_connector === 'string' &&
        typeof row.source_raw_record_id === 'string'
          ? loadObservationBySource(
              adapter,
              String(row.source_connector),
              String(row.source_raw_record_id)
            )
          : null;

      return {
        item_type: 'observation',
        source_type: 'observation',
        source_id: sourceId,
        source_locator: nullableString(row.source_locator),
        event_datetime: eventDatetime,
        event_date: eventDateFromMs(eventDatetime),
        title: nullableString(row.surface_form),
        summary: nullableString(row.context_summary ?? row.surface_form),
        role: membership?.role ?? null,
        confidence: membership?.confidence ?? null,
        membership_reason: membership?.reason ?? null,
        ...(includeConnectorEnrichments
          ? { connector_event: connectorEventSnapshot(connectorEvent) }
          : {}),
      };
    })
    .filter((item) => withinBounds(item.event_datetime, bounds));
}

/**
 * The observation an artifact membership points at.
 *
 * This read the connector event index, which is how a core read came to require
 * the connector package to be installed -- a consumer without it got no timeline
 * and, worse, a migration chain that stopped at 072. Every field the caller uses
 * is on the observation, which is the core's own table and the thing a judgment
 * actually rests on.
 */
/** One observation by the (source, id-within-it) pair that produced it. */
function loadObservationBySource(
  adapter: CaseTimelineRangeAdapter,
  source: string,
  sourceId: string
): ObservationEvidence | null {
  const row = adapter
    .prepare(
      `
        SELECT observation_id, source, source_id, source_type, source_locator, title,
               artifact_locator, artifact_title, body, source_at, observed_at, event_date
        FROM observation_versions
        WHERE source = ? AND source_id = ?
        ORDER BY observed_at DESC, observation_id DESC
        LIMIT 1
      `
    )
    .get(source, sourceId) as Record<string, unknown> | undefined;
  return row ? (row as unknown as ObservationEvidence) : null;
}

function loadArtifactObservation(
  adapter: CaseTimelineRangeAdapter,
  sourceId: string
): ObservationEvidence | null {
  const row = adapter
    .prepare(
      `
        SELECT observation_id, source, source_id, source_type, source_locator, title,
               artifact_locator, artifact_title, body, source_at, observed_at, event_date
        FROM observation_versions
        WHERE observation_id = ?
           OR artifact_locator = ?
        ORDER BY observed_at ASC, observation_id ASC
        LIMIT 1
      `
    )
    .get(sourceId, sourceId) as Record<string, unknown> | undefined;

  return row ? (row as unknown as ObservationEvidence) : null;
}

function loadArtifactItems(
  adapter: CaseTimelineRangeAdapter,
  memberships: CaseAssemblyMembership[],
  bounds: RangeBounds,
  includeConnectorEnrichments: boolean
): CaseTimelineRangeItem[] {
  const artifactMemberships = memberships.filter(
    (membership) => membership.source_type === 'artifact'
  );

  return artifactMemberships
    .map((membership): CaseTimelineRangeItem => {
      const connectorEvent = loadArtifactObservation(adapter, membership.source_id);
      const eventDatetime = connectorEvent?.source_at ?? null;
      return {
        item_type: 'artifact',
        source_type: 'artifact',
        source_id: membership.source_id,
        source_locator:
          connectorEvent?.artifact_locator ??
          connectorEvent?.source_locator ??
          membership.source_id,
        event_datetime: eventDatetime,
        event_date: connectorEvent?.event_date ?? eventDateFromMs(eventDatetime),
        title: connectorEvent?.artifact_title ?? connectorEvent?.title ?? membership.source_id,
        summary: connectorEvent?.body ?? null,
        role: membership.role,
        confidence: membership.confidence,
        membership_reason: membership.reason,
        ...(includeConnectorEnrichments
          ? { connector_event: connectorEventSnapshot(connectorEvent) }
          : {}),
      };
    })
    .filter((item) => withinBounds(item.event_datetime, bounds));
}

export function caseTimelineRange(
  adapter: CaseTimelineRangeAdapter,
  input: CaseTimelineRangeInput
): CaseTimelineRangeResult {
  const bounds = parseBounds(input);
  const limit = normalizeLimit(input.limit);
  const resolution = resolveCanonicalCaseChain(adapter, input.case_id);
  const chainResult = listActiveCorrectionsForCase(adapter, input.case_id);
  const chain = chainResult.chain;
  const memberships = listActiveMembershipsForCaseChain(adapter, chain);

  const items = [
    ...loadDecisionItems(adapter, memberships, bounds),
    ...loadEventItems(adapter, memberships, bounds),
    ...loadObservationItems(
      adapter,
      memberships,
      bounds,
      input.include_connector_enrichments === true
    ),
    ...loadArtifactItems(
      adapter,
      memberships,
      bounds,
      input.include_connector_enrichments === true
    ),
  ].sort(compareItemsAsc);

  const orderedItems = input.order === 'desc' ? [...items].reverse() : items;

  return {
    terminal_case_id: resolution.terminal_case_id,
    resolved_via_case_id: resolution.resolved_via_case_id,
    chain,
    items: orderedItems.slice(0, limit),
  };
}

export type {
  CaseTimelineRangeInput,
  CaseTimelineRangeItem,
  CaseTimelineRangeResult,
} from './case-types.js';
