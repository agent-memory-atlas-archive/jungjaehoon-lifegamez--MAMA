import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

export const ACKNOWLEDGED_DELTA_CAP = 50;

// A type alias, not an interface, so a batch fits a JSON mailbox payload as it is.
export type AcknowledgedSourceDelta = {
  channelLabel: string;
  sourceAt: string;
  preview: string;
  observationRef: string;
};

export interface AcknowledgedSourceDeltaBatch {
  total: number;
  items: AcknowledgedSourceDelta[];
}

interface AcknowledgedDeltaRow {
  preview_json: string;
  payload_json: string;
}

interface StoredSourceRef {
  connector: string;
  channelName?: string;
  observationRef: string;
  sourceAt: string;
  contentPreview?: string;
  metadata?: { channelName?: string };
}

interface StoredSourceDelta {
  collector: string;
  channel: string;
  refs: StoredSourceRef[];
  preview: string[];
}

/** Read the latest acknowledged live deltas in the report window, with a separate total count. */
export function readAcknowledgedSourceDeltas(
  adapter: DatabaseAdapter,
  sinceAt: number,
  throughAt: number
): AcknowledgedSourceDeltaBatch {
  const where = `kind = 'source_delta' AND status = 'acked' AND acked_at >= ? AND acked_at <= ?
    AND payload_json IS NOT NULL AND json_extract(payload_json, '$.replay') IS NULL`;
  const count = adapter
    .prepare(`SELECT COUNT(*) AS total FROM mailbox_inputs WHERE ${where}`)
    .get(sinceAt, throughAt) as { total: number };
  const rows = adapter
    .prepare(
      `SELECT preview_json, payload_json
       FROM mailbox_inputs WHERE ${where} ORDER BY acked_at DESC, id DESC LIMIT ?`
    )
    .all(sinceAt, throughAt, ACKNOWLEDGED_DELTA_CAP) as AcknowledgedDeltaRow[];
  // Past the cap the newest deltas matter most; the reminder reads them oldest first.
  rows.reverse();
  const items = rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as StoredSourceDelta;
    const refs = payload.refs;
    const latestSourceAt = Math.max(...refs.map((ref) => Date.parse(ref.sourceAt)));
    const channelLabel =
      refs[0]?.channelName ?? refs[0]?.metadata?.channelName ?? payload.collector;
    const previews = [
      ...new Set([
        ...payload.preview,
        ...refs.map((ref) => ref.contentPreview ?? ''),
        ...JSON.parse(row.preview_json),
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    return {
      channelLabel,
      sourceAt: new Date(latestSourceAt).toISOString(),
      preview: previews,
      observationRef: refs.map((ref) => ref.observationRef).join(', '),
    };
  });
  return { total: count.total, items };
}
