/**
 * The decision graph, as a caller may see it.
 *
 * The viewer drew this by reading `decisions` and `decision_edges` directly and
 * embedding fifty rows in the HTTP process. Those are reads, and a read answers
 * to the caller's scopes: every node here is a memory the caller's grant admits,
 * every edge joins two such nodes, and the totals count the same admitted set.
 * A principal that admits nothing sees an empty graph rather than the file.
 */
import { ensureMemoryScope, type DatabaseAdapter } from '../db-manager.js';
import { generateEmbedding } from '../embedding/embedder.js';
import { vectorSearch } from '../knowledge/search.js';

export interface GraphReadNode {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  outcome: string | null;
  confidence: number | null;
  created_at: number;
}

export interface GraphReadEdge {
  from: string;
  to: string;
  relationship: string;
  reason: string | null;
}

export interface GraphSimilarityEdge extends GraphReadEdge {
  similarity: number;
}

export interface GraphScope {
  kind: string;
  id: string;
}

/** The admitted-node clause both a node read and an edge read stand on. */
async function admittedScopeIds(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[]
): Promise<string[]> {
  return Promise.all(scopes.map((scope) => ensureMemoryScope(adapter, scope.kind, scope.id)));
}

export async function readGraphNodes(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[],
  options: { limit?: number | null; ids?: readonly string[] } = {}
): Promise<GraphReadNode[]> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const scopePlaceholders = scopeIds.map(() => '?').join(', ');
  const ids = options.ids ?? [];
  const idClause = ids.length > 0 ? `AND d.id IN (${ids.map(() => '?').join(', ')})` : '';
  const limit = options.limit ?? null;
  const rows = (await adapter
    .prepare(
      `SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.outcome, d.confidence, d.created_at
       FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       WHERE msb.scope_id IN (${scopePlaceholders})
       ${idClause}
       ORDER BY d.created_at DESC
       ${limit === null ? '' : 'LIMIT ?'}`
    )
    .all(...scopeIds, ...ids, ...(limit === null ? [] : [limit]))) as GraphReadNode[];
  return rows;
}

export async function readGraphEdges(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[]
): Promise<GraphReadEdge[]> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  // Both ends must be admitted: an edge to a memory this caller cannot read
  // would disclose that it exists, which is the read the join is here to bound.
  const rows = (await adapter
    .prepare(
      `SELECT e.from_id, e.to_id, e.relationship, e.reason
       FROM decision_edges e
       WHERE EXISTS (
               SELECT 1 FROM memory_scope_bindings b
               WHERE b.memory_id = e.from_id AND b.scope_id IN (${placeholders})
             )
         AND EXISTS (
               SELECT 1 FROM memory_scope_bindings b
               WHERE b.memory_id = e.to_id AND b.scope_id IN (${placeholders})
             )`
    )
    .all(...scopeIds, ...scopeIds)) as Array<{
    from_id: string;
    to_id: string;
    relationship: string;
    reason: string | null;
  }>;
  return rows.map((row) => ({
    from: row.from_id,
    to: row.to_id,
    relationship: row.relationship,
    reason: row.reason,
  }));
}

export async function countGraphNodes(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[]
): Promise<number> {
  if (scopes.length === 0) {
    return 0;
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  const row = (await adapter
    .prepare(
      `SELECT COUNT(DISTINCT d.id) as count FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       WHERE msb.scope_id IN (${placeholders})`
    )
    .get(...scopeIds)) as { count?: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Similarity edges over the admitted set.
 *
 * This embeds a bounded window of admitted nodes and asks the vector index what
 * each is near. It lives here rather than in an HTTP handler because that is
 * where the embedder is — a door that embeds is a door that has opinions about
 * what memory means.
 */
export async function readGraphSimilarityEdges(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[],
  options: { window?: number; neighbors?: number; threshold?: number } = {}
): Promise<GraphSimilarityEdge[]> {
  const window = options.window ?? 50;
  const neighbors = options.neighbors ?? 3;
  const threshold = options.threshold ?? 0.7;
  const nodes = await readGraphNodes(adapter, scopes, { limit: Math.max(window * 2, window) });
  if (nodes.length < 2) {
    return [];
  }
  const admitted = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const edges: GraphSimilarityEdge[] = [];
  for (const node of nodes.slice(0, window)) {
    const embedding = await generateEmbedding(`${node.topic} ${node.decision}`, 'query');
    const similar = (await vectorSearch(
      adapter as never,
      embedding,
      neighbors,
      threshold
    )) as Array<{ id: string; similarity?: number }>;
    for (const match of similar) {
      // A neighbour the caller may not read is not an edge it may see.
      if (match.id === node.id || !admitted.has(match.id)) {
        continue;
      }
      const similarity = match.similarity ?? threshold;
      if (similarity <= threshold) {
        continue;
      }
      const key = [node.id, match.id].sort().join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({
        from: node.id,
        to: match.id,
        relationship: 'similar',
        reason: null,
        similarity,
      });
    }
  }
  return edges;
}
