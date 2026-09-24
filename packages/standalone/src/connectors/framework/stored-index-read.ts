/** Read projections owned alongside connector_event_index, independent of polling. */
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

type Reader = Pick<DatabaseAdapter, 'prepare'>;

export function listStoredConnectorNames(adapter: Reader): string[] {
  const rows = adapter
    .prepare('SELECT DISTINCT source_connector FROM connector_event_index')
    .all() as Array<{ source_connector: string }>;
  return rows.map((row) => row.source_connector);
}

export function hasStoredConnector(adapter: Reader, source: string): boolean {
  return Boolean(
    adapter
      .prepare('SELECT 1 FROM connector_event_index WHERE source_connector = ? LIMIT 1')
      .get(source) ??
    adapter.prepare('SELECT 1 FROM observation_versions WHERE source = ? LIMIT 1').get(source)
  );
}

export function storedConnectorOverview(
  adapter: Reader,
  source: string,
  channels: readonly string[] | null
): Record<string, unknown> {
  const clause = channels ? ` AND e.channel IN (${channels.map(() => '?').join(', ')})` : '';
  return adapter
    .prepare(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT e.channel) AS channel_count,
              MIN(e.source_timestamp_ms) AS first_source_at,
              MAX(e.source_timestamp_ms) AS last_source_at,
              MAX(o.observed_at) AS last_observed_at
       FROM connector_event_index e
       LEFT JOIN observation_versions o ON o.observation_id = e.current_observation_id
       WHERE e.source_connector = ?${clause}`
    )
    .get(source, ...(channels ?? [])) as Record<string, unknown>;
}

export function storedObservationChannel(
  adapter: Reader,
  observationRef: string,
  source: string
): string | null | undefined {
  const row = adapter
    .prepare(
      `SELECT o.channel FROM observation_versions o
       WHERE o.observation_id = ? AND o.source = ? LIMIT 1`
    )
    .get(observationRef, source) as { channel: string | null } | undefined;
  return row?.channel;
}
