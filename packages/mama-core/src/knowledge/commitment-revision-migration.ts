import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';

interface AssignmentRow {
  commitment_id: string;
  revision: number;
  record_id: string;
  operation: 'create' | 'revise' | 'withdraw';
  agent_id: string | null;
  model_run_id: string | null;
  created_at: number;
}

interface DecisionRow {
  topic: string;
}

interface RevisionLink {
  relation: 'builds_on';
  target: { kind: 'memory'; id: string };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function edgeId(commandId: string, relation: string, target: RevisionLink['target']): string {
  return `edge_${sha256(canonicalizeJSON({ commandId, index: 0, relation, target }))
    .toString('hex')
    .slice(0, 24)}`;
}

/** Restore the topic and graph relation for every pre-migration commitment history. */
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

  const getDecision = adapter.prepare('SELECT topic FROM decisions WHERE id = ?');
  const setTopic = adapter.prepare('UPDATE decisions SET topic = ? WHERE id = ?');
  const hasEdge = adapter.prepare(
    `SELECT 1 FROM twin_edges
     WHERE edge_type = 'builds_on'
       AND subject_kind = 'memory' AND subject_id = ?
       AND object_kind = 'memory' AND object_id = ?`
  );
  const insertEdge = adapter.prepare(
    `INSERT OR IGNORE INTO twin_edges (
       edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
       relation_attrs_json, confidence, source, agent_id, model_run_id,
       edge_idempotency_key, content_hash, created_at
     ) VALUES (?, 'builds_on', 'memory', ?, 'memory', ?, '{}', 1.0, 'code', ?, ?, ?, ?, ?)`
  );

  for (const [commitmentId, revisions] of byCommitment) {
    const first = revisions.find((revision) => revision.operation === 'create');
    if (!first) throw new Error(`Commitment ${commitmentId} has no create assignment`);
    const firstDecision = getDecision.get(first.record_id) as DecisionRow | undefined;
    if (!firstDecision || typeof firstDecision.topic !== 'string') {
      throw new Error(`Commitment ${commitmentId} create record is unavailable`);
    }

    for (let index = 0; index < revisions.length; index += 1) {
      const current = revisions[index]!;
      const currentDecision = getDecision.get(current.record_id) as DecisionRow | undefined;
      if (!currentDecision) {
        throw new Error(
          `Commitment ${commitmentId} revision ${current.revision} record is unavailable`
        );
      }
      setTopic.run(firstDecision.topic, current.record_id);
      if (current.operation === 'create') continue;

      const previous = revisions[index - 1];
      if (!previous) {
        throw new Error(
          `Commitment ${commitmentId} revision ${current.revision} has no predecessor`
        );
      }
      if (hasEdge.get(current.record_id, previous.record_id)) continue;

      const target = { kind: 'memory' as const, id: previous.record_id };
      const link: RevisionLink = { relation: 'builds_on', target };
      const id = edgeId(`migration:099:${commitmentId}:${current.revision}`, link.relation, target);
      const contentHash = sha256(canonicalizeJSON({ id, recordId: current.record_id, link }));
      insertEdge.run(
        id,
        current.record_id,
        previous.record_id,
        current.agent_id,
        current.model_run_id,
        id,
        contentHash,
        current.created_at
      );
    }
  }
}
