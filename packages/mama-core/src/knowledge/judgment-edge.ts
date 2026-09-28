import crypto from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { RecordLink, WorkReference } from '../memory/judgment-types.js';

/** The stable id of the index-th link a judgment command writes. */
export function judgmentEdgeId(
  commandId: string,
  index: number,
  relation: string,
  target: WorkReference
): string {
  return `edge_${crypto
    .createHash('sha256')
    .update(canonicalizeJSON({ commandId, index, relation, target }))
    .digest('hex')
    .slice(0, 24)}`;
}

/** The content hash stored on a judgment link's twin edge. */
export function judgmentEdgeContentHash(id: string, recordId: string, link: RecordLink): Buffer {
  return crypto.createHash('sha256').update(canonicalizeJSON({ id, recordId, link })).digest();
}
