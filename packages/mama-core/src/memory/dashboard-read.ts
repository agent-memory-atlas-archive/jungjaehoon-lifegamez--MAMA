/**
 * Listings and rollups over the memory a caller may see.
 *
 * The dashboard asked these of the database directly: which decisions are
 * active and going stale, what changed recently, which projects are busy, and
 * what one project holds. They are reads, so they answer to the caller's
 * scopes — the same join every other admitted read stands on. A principal that
 * admits nothing gets empty lists rather than the whole file.
 */
import { ensureMemoryScope, type DatabaseAdapter } from '../db-manager.js';

export interface DecisionListingRow {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  status: string | null;
  confidence?: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRollup {
  project: string;
  activeDecisions: number;
  lastActivity: number;
}

export interface ReadScope {
  kind: string;
  id: string;
}

async function admittedScopeIds(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[]
): Promise<string[]> {
  return Promise.all(scopes.map((scope) => ensureMemoryScope(adapter, scope.kind, scope.id)));
}

/**
 * Recent or stale decisions under the admitted scopes.
 *
 * `order: 'stale'` puts the least recently touched first — what the dashboard
 * calls an alert. `order: 'recent'` is the activity feed. `status` narrows to
 * one lifecycle state when the caller names it.
 */
export async function readDecisionListing(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[],
  options: { status?: string; order?: 'recent' | 'stale'; limit?: number } = {}
): Promise<DecisionListingRow[]> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  const status = typeof options.status === 'string' ? options.status.trim() : '';
  const direction = options.order === 'stale' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  return (await adapter
    .prepare(
      `SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.status, d.confidence,
              d.created_at, d.updated_at
       FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       WHERE msb.scope_id IN (${placeholders})
       ${status ? 'AND d.status = ?' : ''}
       ORDER BY d.updated_at ${direction}
       LIMIT ?`
    )
    .all(...scopeIds, ...(status ? [status] : []), limit)) as DecisionListingRow[];
}

/** Per-project active-decision counts and last activity, over admitted scopes. */
export async function readProjectRollups(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[]
): Promise<ProjectRollup[]> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  return (await adapter
    .prepare(
      `SELECT ms.external_id AS project,
              COUNT(DISTINCT d.id) AS activeDecisions,
              MAX(d.updated_at) AS lastActivity
       FROM memory_scopes ms
       JOIN memory_scope_bindings msb ON msb.scope_id = ms.id
       JOIN decisions d ON d.id = msb.memory_id
       WHERE ms.kind = 'project'
         AND d.status = 'active'
         AND EXISTS (
               SELECT 1 FROM memory_scope_bindings admitted
               WHERE admitted.memory_id = d.id AND admitted.scope_id IN (${placeholders})
             )
       GROUP BY ms.external_id
       ORDER BY lastActivity DESC`
    )
    .all(...scopeIds)) as ProjectRollup[];
}

/** What one project holds, still bounded by what the caller admits. */
export async function readProjectDecisions(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[],
  project: string,
  limit = 50
): Promise<DecisionListingRow[]> {
  if (scopes.length === 0 || project.trim() === '') {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
  return (await adapter
    .prepare(
      `SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.status, d.confidence,
              d.created_at, d.updated_at
       FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       JOIN memory_scopes ms ON ms.id = msb.scope_id
       WHERE ms.kind = 'project'
         AND ms.external_id = ?
         AND EXISTS (
               SELECT 1 FROM memory_scope_bindings admitted
               WHERE admitted.memory_id = d.id AND admitted.scope_id IN (${placeholders})
             )
       ORDER BY d.updated_at DESC
       LIMIT ?`
    )
    .all(project, ...scopeIds, bounded)) as DecisionListingRow[];
}
