import type { DatabaseAdapter } from '../db-manager.js';
import type { RecordLink } from '../memory/judgment-types.js';
import { judgmentEdgeContentHash, judgmentEdgeId } from './judgment-edge.js';

interface AssignmentRow {
  commitment_id: string;
  revision: number;
  record_id: string;
  operation: 'create' | 'revise' | 'withdraw';
  agent_id: string | null;
  model_run_id: string | null;
  created_at: number;
}

/** Link every stored commitment revision to the revision it follows. */
export function backfillCommitmentRevisionGraph(adapter: DatabaseAdapter): void {
  const assignments = adapter
    .prepare(
      `SELECT assignment.commitment_id, assignment.revision, assignment.record_id, assignment.operation,
              assignment.agent_id, assignment.model_run_id, assignment.created_at
       FROM commitment_assignments AS assignment
       JOIN commitments AS commitment ON commitment.commitment_id = assignment.commitment_id
       ORDER BY assignment.commitment_id, assignment.revision`
    )
    .all() as AssignmentRow[];
  if (assignments.length === 0) return;
  const byCommitment = new Map<string, AssignmentRow[]>();
  for (const assignment of assignments) {
    const rows = byCommitment.get(assignment.commitment_id) ?? [];
    rows.push(assignment);
    byCommitment.set(assignment.commitment_id, rows);
  }

  const hasEdge = adapter.prepare(
    `SELECT 1 FROM twin_edges
     WHERE edge_type = 'builds_on'
       AND subject_kind = 'memory' AND subject_id = ?
       AND object_kind = 'memory' AND object_id = ?`
  );
  const insertEdge = adapter.prepare(
    `INSERT OR IGNORE INTO twin_edges (
       edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
       relation_attrs_json, confidence, source, agent_id, model_run_id, content_hash, created_at
     ) VALUES (?, 'builds_on', 'memory', ?, 'memory', ?, '{}', 1.0, 'code', ?, ?, ?, ?)`
  );

  for (const [commitmentId, revisions] of byCommitment) {
    for (let index = 0; index < revisions.length; index += 1) {
      const current = revisions[index]!;
      if (current.operation === 'create') continue;

      const previous = revisions[index - 1];
      if (!previous) {
        throw new Error(
          `Commitment ${commitmentId} revision ${current.revision} has no predecessor`
        );
      }
      if (hasEdge.get(current.record_id, previous.record_id)) continue;

      const link: RecordLink = {
        relation: 'builds_on',
        target: { kind: 'memory', id: previous.record_id },
      };
      const id = judgmentEdgeId(
        `migration:099:${commitmentId}:${current.revision}`,
        0,
        link.relation,
        link.target
      );
      insertEdge.run(
        id,
        current.record_id,
        previous.record_id,
        current.agent_id,
        current.model_run_id,
        judgmentEdgeContentHash(id, current.record_id, link),
        current.created_at
      );
    }
  }
}
