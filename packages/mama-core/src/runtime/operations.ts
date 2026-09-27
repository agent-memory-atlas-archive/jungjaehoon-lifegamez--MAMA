/**
 * The durable record of what this system actually changed, and what caused it.
 *
 * One table, `evidence_effects`. A `cause_state` CHECK forbids both "attributed
 * with no cause" and "unattributed with a cause", and a BEFORE INSERT trigger
 * rejects unusable cause ids, so the numerator and the denominator of coverage
 * cannot be separated.
 *
 * This lives in core, next to the commitments it describes, for one reason: a
 * change and its cause have to commit or roll back together. While owner work
 * was stored in the daemon's operator database and this ledger beside it, that
 * held. Moving owner work into the knowledge database without moving this would
 * have put a change in one database and its cause in another, and a ledger that
 * can disagree with the rows it describes is worse than no ledger.
 *
 * Every function here takes its adapter, so the caller decides which database is
 * being recorded; nothing is resolved from a global.
 *
 * @module runtime/operations
 */

import { createHash } from 'node:crypto';
import type { JudgmentReceipt } from '../memory/judgment-types.js';
import type { JudgmentAccess } from '../knowledge/judgments.js';

export type EffectKind =
  | 'task_create'
  | 'task_update'
  | 'report_update'
  | 'report_publish'
  | 'memory_write'
  | 'wiki_write'
  | 'file_export'
  | 'repair_request'
  | 'run_budget_stop';

/** What it happened to. */
export type EffectTarget =
  | 'task'
  | 'report_slot'
  | 'memory'
  | 'wiki_page'
  | 'file'
  | 'issue'
  | 'run';

/** Whether the change could name what caused it. */
export type CauseState = 'attributed' | 'unattributed';

/**
 * WHY the change happened - the closed set (S2). `event` is the only kind that
 * carries source event ids; the others are honestly id-less: a clock advanced,
 * the owner asked in chat, or a card transition cascaded. Writers pass their
 * kind explicitly - the ledger never infers.
 */
export type CauseKind = 'event' | 'owner_message' | 'clock' | 'card_transition';

/** Kinds an unattributed (id-less) change may claim. */
export type UnattributedCauseKind = Exclude<CauseKind, 'event'>;

/** Fields every durable change carries, whether or not it can name a cause. */
export interface ChangeInput {
  /**
   * The model run that produced the change, so it is traceable to a transcript.
   * Null when no model run did - a host-internal write is not made more honest by
   * inventing a run id for it.
   */
  runId?: string | null;
  /** Evidence channel this change concerns, when it concerns one. */
  channelId?: string | null;
  kind: EffectKind;
  targetType: EffectTarget;
  targetId: string;
  /** The written payload; hashed, never stored, so the ledger cannot leak content. */
  payload: unknown;
  atMs: number;
}

export interface EffectInput extends ChangeInput {
  /** Events that caused it. Must not be empty. */
  sourceEventIds: readonly string[];
}

export interface EffectRecord {
  id: number;
  runId: string | null;
  channelId: string | null;
  causeState: CauseState;
  causeKind: CauseKind;
  sourceEventIds: string[];
  kind: EffectKind;
  targetType: EffectTarget;
  targetId: string;
  payloadHash: string;
  atMs: number;
}

const EFFECT_KINDS: readonly EffectKind[] = [
  'task_create',
  'task_update',
  'report_update',
  'report_publish',
  'memory_write',
  'wiki_write',
  'file_export',
  'repair_request',
  'run_budget_stop',
];

const EFFECT_TARGETS: readonly EffectTarget[] = [
  'task',
  'report_slot',
  'memory',
  'wiki_page',
  'file',
  'issue',
  'run',
];

/** Long enough for any upstream id, short enough that the column cannot carry content. */
const MAX_EVENT_ID_LENGTH = 200;
const PAYLOAD_HASH_LENGTH = 32;

/**
 * Whether a value can serve as a cause at all.
 *
 * Callers ask before writing rather than discovering it as a constraint violation,
 * because the answer changes what they record, not whether they may proceed: a malformed
 * cause makes a change unattributed, it does not make the change illegitimate. Legacy
 * rows really do carry 400-character source identifiers, and refusing to let the operator
 * update a work item because its upstream id is the wrong shape would be enforcement
 * bought with the owner's work.
 */
export function isUsableCause(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_EVENT_ID_LENGTH;
}

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

export const EVIDENCE_EFFECTS_DDL = `
  CREATE TABLE IF NOT EXISTS evidence_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    channel_id TEXT,
    cause_state TEXT NOT NULL CHECK (cause_state IN ('attributed', 'unattributed')),
    cause_kind TEXT NOT NULL
      CHECK (cause_kind IN ('event', 'owner_message', 'clock', 'card_transition')),
    source_event_ids_json TEXT NOT NULL
      CHECK (
        json_valid(source_event_ids_json)
        AND (
          (cause_state = 'attributed' AND json_array_length(source_event_ids_json) >= 1)
          OR (cause_state = 'unattributed' AND json_array_length(source_event_ids_json) = 0)
        )
      ),
    effect_kind TEXT NOT NULL CHECK (effect_kind IN (${quoted(EFFECT_KINDS)})),
    target_type TEXT NOT NULL CHECK (target_type IN (${quoted(EFFECT_TARGETS)})),
    target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = ${PAYLOAD_HASH_LENGTH}),
    created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
  )
`;

/**
 * Per-element shape of the cause list.
 *
 * A trigger rather than a CHECK because SQLite forbids subqueries in CHECK, and checking
 * each element needs `json_each`. Without this the column enforces only "non-empty array",
 * which `[""]` and `[null]` and `[0]` all satisfy while naming nothing.
 *
 * The length bound is not cosmetic: an unbounded cause id turns an audit ledger into a
 * content channel, which is the one thing the payload is hashed to avoid.
 */
const EVIDENCE_EFFECTS_CAUSE_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS evidence_effects_cause_shape
  BEFORE INSERT ON evidence_effects
  WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_event_ids_json)
     WHERE json_each.type <> 'text'
        OR trim(json_each.value) = ''
        OR length(json_each.value) > ${MAX_EVENT_ID_LENGTH}
  )
  BEGIN
    SELECT RAISE(ABORT, 'evidence_effects: a cause must be a non-empty event id');
  END
`;

/**
 * kind <-> ids cross-shape. A trigger (not a table CHECK) so it applies
 * identically to fresh tables and ALTERed old ones: `event` must carry ids,
 * the id-less kinds must not - a clock that names events or an event that
 * names none is a fabricated cause either way.
 */
const EVIDENCE_EFFECTS_KIND_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS evidence_effects_kind_shape
  BEFORE INSERT ON evidence_effects
  WHEN (NEW.cause_kind = 'event' AND json_array_length(NEW.source_event_ids_json) = 0)
    OR (NEW.cause_kind <> 'event' AND json_array_length(NEW.source_event_ids_json) > 0)
  BEGIN
    SELECT RAISE(ABORT, 'evidence_effects: cause_kind and source_event_ids disagree');
  END
`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_run
     ON evidence_effects(run_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_target
     ON evidence_effects(target_type, target_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_channel
     ON evidence_effects(channel_id, created_at DESC)`,
  // Coverage is meant to be cheap enough that nobody has an excuse not to look.
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_coverage
     ON evidence_effects(created_at DESC, cause_state)`,
];

export interface EffectAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid?: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}

export function ensureEffectLedger(adapter: EffectAdapter): void {
  adapter.prepare(EVIDENCE_EFFECTS_DDL).run();
  migrateCauseKind(adapter);
  widenClosedSets(adapter);
  adapter.prepare(EVIDENCE_EFFECTS_CAUSE_TRIGGER).run();
  adapter.prepare(EVIDENCE_EFFECTS_KIND_TRIGGER).run();
  for (const sql of INDEXES) {
    adapter.prepare(sql).run();
  }
}

/**
 * S2 migration: add cause_kind to pre-existing ledgers and backfill by
 * DISCRIMINATOR, never blanket (review #3 - "104 -> clock" would stamp owner-
 * and API-driven changes with a fabricated clock cause):
 *   attributed                          -> event  (ids >= 1, DB-checked)
 *   unattributed + temporal-effect join -> clock  (a temporal check fired)
 *   unattributed + run_id present       -> clock  (scheduled board:full run)
 *   remaining unattributed              -> owner_message (console/API writes
 *                                          carry no run and no batch)
 * ALTER ADD COLUMN with CHECK is legal SQLite (verified 2026-07-31; the
 * prohibition covers PK/UNIQUE) - no table rebuild.
 */
function migrateCauseKind(adapter: EffectAdapter): void {
  const columns = adapter.prepare(`PRAGMA table_info(evidence_effects)`).all() as Array<{
    name?: unknown;
  }>;
  if (columns.some((column) => column.name === 'cause_kind')) {
    return;
  }
  adapter
    .prepare(
      `ALTER TABLE evidence_effects ADD COLUMN cause_kind TEXT NOT NULL DEFAULT 'clock'
         CHECK (cause_kind IN ('event', 'owner_message', 'clock', 'card_transition'))`
    )
    .run();
  adapter
    .prepare(`UPDATE evidence_effects SET cause_kind = 'event' WHERE cause_state = 'attributed'`)
    .run();
  const hasTemporalTable =
    (adapter
      .prepare(
        `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='operator_temporal_effects'`
      )
      .all().length ?? 0) > 0;
  if (hasTemporalTable) {
    adapter
      .prepare(
        `UPDATE evidence_effects SET cause_kind = 'clock'
          WHERE cause_state = 'unattributed'
            AND EXISTS (SELECT 1 FROM operator_temporal_effects t
                         WHERE CAST(t.task_id AS TEXT) = evidence_effects.target_id)`
      )
      .run();
  }
  // run_id-bearing unattributed rows are scheduled runs (board:full and
  // friends): the ALTER's DEFAULT already left them 'clock', which is the
  // intended label - no UPDATE needed (a `cause_kind <> 'clock'` predicate
  // here would be dead code, review).
  adapter
    .prepare(
      hasTemporalTable
        ? `UPDATE evidence_effects SET cause_kind = 'owner_message'
             WHERE cause_state = 'unattributed' AND run_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM operator_temporal_effects t
                                WHERE CAST(t.task_id AS TEXT) = evidence_effects.target_id)`
        : `UPDATE evidence_effects SET cause_kind = 'owner_message'
             WHERE cause_state = 'unattributed' AND run_id IS NULL`
    )
    .run();
}

/**
 * Phase 3 migration: the effect_kind / target_type CHECKs are closed sets baked into the
 * table, and SQLite cannot alter a CHECK in place. When an installed ledger's CHECK is
 * narrower than the current constants, rebuild the table inside one transaction: copy every
 * row with identical ids and created_at, keep the cause_state CHECK and both triggers
 * byte-identical (they are the invariant the ledger rests on), recreate the indices.
 * Detection reads the stored DDL, so a ledger that already carries the current sets is
 * untouched on every later boot.
 */
function widenClosedSets(adapter: EffectAdapter): void {
  const row = adapter
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='evidence_effects'`)
    .all()[0] as { sql?: string } | undefined;
  const storedDdl = row?.sql ?? '';
  const missing = [...EFFECT_KINDS, ...EFFECT_TARGETS].filter(
    (value) => !storedDdl.includes(`'${value}'`)
  );
  if (missing.length === 0) {
    return;
  }
  const run = (sql: string) => adapter.prepare(sql).run();
  run('BEGIN IMMEDIATE');
  try {
    run(EVIDENCE_EFFECTS_DDL.replace('evidence_effects (', 'evidence_effects_new ('));
    run(
      `INSERT INTO evidence_effects_new
         (id, run_id, channel_id, cause_state, cause_kind, source_event_ids_json,
          effect_kind, target_type, target_id, payload_hash, created_at)
       SELECT id, run_id, channel_id, cause_state, cause_kind, source_event_ids_json,
              effect_kind, target_type, target_id, payload_hash, created_at
         FROM evidence_effects`
    );
    run('DROP TABLE evidence_effects');
    run('ALTER TABLE evidence_effects_new RENAME TO evidence_effects');
    run(EVIDENCE_EFFECTS_CAUSE_TRIGGER);
    run(EVIDENCE_EFFECTS_KIND_TRIGGER);
    for (const sql of INDEXES) {
      run(sql);
    }
    run('COMMIT');
  } catch (error) {
    try {
      run('ROLLBACK');
    } catch {
      // BEGIN itself may have failed (busy lock, nested transaction): keep the original error.
    }
    throw error;
  }
}

export class EffectWithoutCauseError extends Error {
  constructor(kind: EffectKind, targetId: string) {
    super(
      `Refusing to record ${kind} on ${targetId} with no source events: a change that cannot name its cause is not an effect.`
    );
    this.name = 'EffectWithoutCauseError';
  }
}

/** Stable hash of what was written. The ledger proves a change happened, not what it said. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex')
    .slice(0, PAYLOAD_HASH_LENGTH);
}

/**
 * Record a durable change.
 *
 * Throws rather than returning a failure when the cause is missing. A caller that wrote
 * something and then could not say why must not proceed as if the write were accounted
 * for - silently skipping the ledger row is how 1,169 runs closed as `done` while five
 * receipts existed.
 */
export function recordEffect(adapter: EffectAdapter, input: EffectInput): number {
  const sourceEventIds = [
    ...new Set(input.sourceEventIds.filter(isUsableCause).map((id) => id.trim())),
  ];
  if (sourceEventIds.length === 0) {
    throw new EffectWithoutCauseError(input.kind, input.targetId);
  }
  return insertChange(adapter, input, 'event', sourceEventIds);
}

/**
 * Record a durable change that could not name what caused it.
 *
 * Deliberately a separate function with an uncomfortable name. Every call is an admission
 * that the system changed something it cannot explain, and the point is that the count of
 * these is visible next to the count of real effects rather than absent from both.
 */
export function recordUnattributedChange(
  adapter: EffectAdapter,
  input: ChangeInput,
  causeKind: UnattributedCauseKind
): number {
  return insertChange(adapter, input, causeKind, []);
}

function insertChange(
  adapter: EffectAdapter,
  input: ChangeInput,
  causeKind: CauseKind,
  sourceEventIds: readonly string[]
): number {
  const result = adapter
    .prepare(
      `INSERT INTO evidence_effects
         (run_id, channel_id, cause_state, cause_kind, source_event_ids_json,
          effect_kind, target_type, target_id, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.runId ?? null,
      input.channelId ?? null,
      causeKind === 'event' ? 'attributed' : 'unattributed',
      causeKind,
      JSON.stringify(sourceEventIds),
      input.kind,
      input.targetType,
      input.targetId,
      payloadHash(input.payload),
      input.atMs
    );
  return Number(result.lastInsertRowid ?? 0);
}

export interface EffectQuery {
  id?: number;
  runId?: string;
  targetType?: EffectTarget;
  targetId?: string;
  causeState?: CauseState;
  sinceMs?: number;
  limit?: number;
}

/** Read effects back, newest first - the substrate a report projects from. */
export function listEffects(adapter: EffectAdapter, query: EffectQuery = {}): EffectRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.id !== undefined) {
    clauses.push('id = ?');
    params.push(query.id);
  }
  if (query.runId !== undefined) {
    clauses.push('run_id = ?');
    params.push(query.runId);
  }
  if (query.targetType !== undefined) {
    clauses.push('target_type = ?');
    params.push(query.targetType);
  }
  if (query.targetId !== undefined) {
    clauses.push('target_id = ?');
    params.push(query.targetId);
  }
  if (query.causeState !== undefined) {
    clauses.push('cause_state = ?');
    params.push(query.causeState);
  }
  if (query.sinceMs !== undefined) {
    clauses.push('created_at >= ?');
    params.push(query.sinceMs);
  }
  params.push(Math.min(Math.max(query.limit ?? 200, 1), 1000));

  const rows = adapter
    .prepare(
      `SELECT * FROM evidence_effects
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    channelId: typeof row.channel_id === 'string' ? row.channel_id : null,
    causeState: String(row.cause_state) as CauseState,
    causeKind: String(row.cause_kind) as CauseKind,
    sourceEventIds: JSON.parse(String(row.source_event_ids_json)) as string[],
    kind: String(row.effect_kind) as EffectKind,
    targetType: String(row.target_type) as EffectTarget,
    targetId: String(row.target_id),
    payloadHash: String(row.payload_hash),
    atMs: Number(row.created_at),
  }));
}

export interface ChangeCoverage {
  /** Changes that named the events behind them. */
  attributed: number;
  /** Changes the system made and could not explain. */
  unattributed: number;
}

/**
 * How much of what the system changed rests on evidence.
 *
 * The single number this ledger exists to make answerable, and the one the previous shape
 * of the system could not produce at all.
 */
export function changeCoverage(
  adapter: EffectAdapter,
  sinceMs?: number,
  targetType?: EffectTarget
): ChangeCoverage {
  // Coverage must describe the same population as the rows a caller is looking at, or the
  // two halves of one answer disagree and the reader cannot tell which is wrong.
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (sinceMs !== undefined) {
    clauses.push('created_at >= ?');
    params.push(sinceMs);
  }
  if (targetType !== undefined) {
    clauses.push('target_type = ?');
    params.push(targetType);
  }
  const rows = adapter
    .prepare(
      `SELECT cause_state, COUNT(*) AS n FROM evidence_effects
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        GROUP BY cause_state`
    )
    .all(...params) as Array<Record<string, unknown>>;
  const coverage: ChangeCoverage = { attributed: 0, unattributed: 0 };
  for (const row of rows) {
    if (row.cause_state === 'attributed') coverage.attributed = Number(row.n);
    if (row.cause_state === 'unattributed') coverage.unattributed = Number(row.n);
  }
  return coverage;
}

// ── Operation reads ─────────────────────────────────────────────────────────
// What operation.get serves: which command the client's operationId bound to,
// under whose authority, and the receipt it committed — the answer to a call
// whose reply was lost after a possible commit.

export interface OperationRead {
  operationId: string;
  /** The command action the binding recorded — e.g. 'judgment.append'. */
  action: string;
  principalId: string;
  payloadHash: string;
  boundAt: number;
  receiptKind: string | null;
  receiptKey: string | null;
  /** The committed judgment receipt, when the binding carries one. */
  receipt: JudgmentReceipt | null;
}

export class OperationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
  }
}

export type OperationReadAdapter = {
  prepare(sql: string): { get(...params: unknown[]): unknown };
};

/**
 * §293: start from the command binding — principal, action, original receipt
 * ref — check the caller's authority, then read the actual result. An absent
 * binding and one bound to another principal answer identically: the caller
 * may not learn the id exists.
 */
export function readOperation(
  adapter: OperationReadAdapter,
  operationId: string,
  access: JudgmentAccess
): OperationRead {
  const binding = adapter
    .prepare(
      `SELECT principal_id, action, payload_hash, receipt_kind, receipt_key, created_at
       FROM command_bindings WHERE command_id = ?`
    )
    .get(operationId) as
    | {
        principal_id: string;
        action: string;
        payload_hash: string;
        receipt_kind: string | null;
        receipt_key: string | null;
        created_at: number;
      }
    | undefined;
  if (binding === undefined || binding.principal_id !== access.principalId) {
    throw new OperationError('OPERATION_UNAVAILABLE', `operation ${operationId} is not available`);
  }

  let receipt: JudgmentReceipt | null = null;
  if (binding.receipt_kind === 'judgment') {
    const row = adapter
      .prepare('SELECT receipt_json FROM judgment_commands WHERE command_id = ?')
      .get(operationId) as { receipt_json: string } | undefined;
    if (row !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.receipt_json);
      } catch (error) {
        throw new Error('judgment_commands.receipt_json is malformed', { cause: error });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('judgment_commands.receipt_json must contain an object');
      }
      receipt = parsed as JudgmentReceipt;
    }
  }

  return {
    operationId,
    action: binding.action,
    principalId: binding.principal_id,
    payloadHash: binding.payload_hash,
    boundAt: binding.created_at,
    receiptKind: binding.receipt_kind,
    receiptKey: binding.receipt_key,
    receipt,
  };
}

// ── Changes read — the reporting projection over this ledger ───────────────
// The read side of the effect ledger: what this system changed, and on what
// evidence. The failure this projection was rewritten for: rows are capped,
// coverage is not. With 40 attributed and 80 unattributed changes in a window,
// a default call returned 50 rows - all unattributed, because the newest
// changes skew that way while `task_update` has no cause field - beside a
// coverage count saying 40 were explainable, and nothing anywhere saying 120
// matched. A model reading its own output could truthfully report "nothing I
// did is explainable". So the counts and the rows must describe the same
// population, the cap must be visible, and a filter the caller misspells must
// fail loudly rather than return zero rows - "no rows" and "nothing changed"
// are the same sentence to a reader, and only one of them is ever true.

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Below this a window is not a window; it is a corrupted number reaching toISOString. */
const MIN_SINCE_MS = 0;

// Narrower than EFFECT_TARGETS on purpose: the read filter names only the
// targets this ledger has ever recorded — file/issue/run effects are writable
// but no writer produces them, so accepting them as filters would be a promise
// the ledger cannot keep.
export const CHANGES_READ_TARGET_TYPES: readonly EffectTarget[] = [
  'task',
  'report_slot',
  'memory',
  'wiki_page',
];
export const CHANGES_READ_CAUSE_STATES: readonly CauseState[] = ['attributed', 'unattributed'];

/**
 * The read port over `evidence_effects`. The table lives in whichever database
 * the host opened it in, so the catalog takes the port rather than an adapter —
 * the port's owner decides the physical store.
 */
export interface ChangesLedger {
  listChanges(query: EffectQuery): EffectRecord[];
  changeCoverage(sinceMs?: number, targetType?: EffectTarget): ChangeCoverage;
  listTurnInputs?(
    modelRunId: string,
    principalId: string,
    options?: { afterId?: number; limit?: number }
  ): {
    items: Array<{
      inputId: number;
      stimulusId: string;
      kind: string;
      principalId: string;
      channelKey: string;
      occurredAt: number;
      status: string;
      nativeState: string;
    }>;
    nextCursor: number | null;
    runStatus: string;
  };
}

export interface ChangesReadInput {
  since?: unknown;
  target_type?: unknown;
  cause_state?: unknown;
  limit?: unknown;
}

export interface ChangesReadFailure {
  success: false;
  code: 'invalid_argument';
  error: string;
}

export interface ChangesReadResult {
  success: true;
  coverage: ChangeCoverage;
  since: string;
  /** Changes matching the filter in the window - not the number returned. */
  total: number;
  returned: number;
  changes: Array<{
    effect_id: number;
    kind: string;
    target_type: string;
    target_id: string;
    cause_state: string;
    /** What KIND of cause moved this - the rubric's cause-citation item reads it. */
    cause_kind: string;
    source_event_ids: string[];
    channel: string | null;
    run_id: string | null;
    at: string;
  }>;
}

/**
 * The window a read covers.
 *
 * Unparseable input falls back to the default and the resolved window is returned to the
 * caller, so whatever was asked for, what was actually read is stated. Non-string input is
 * not a window at all - a model emitting epoch milliseconds used to crash the tool on
 * `.trim()`.
 */
export function parseChangesSince(since: unknown, nowMs: number): number {
  const raw = typeof since === 'string' ? since.trim() : '';
  if (raw === '') return nowMs - DEFAULT_WINDOW_MS;

  // Minutes are here because a caller writing "30m" is entirely ordinary, and without
  // the unit it fell through to the 24-hour default - a window 48x wider than asked for.
  const relative = /^(\d+)\s*([dhm])$/i.exec(raw);
  if (relative) {
    const unit = relative[2].toLowerCase();
    const unitMs = unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 60 * 1000;
    // Clamped: a window of 99999999999 days is not a request, and an unclamped one
    // produces a timestamp that throws on the way back out.
    return clampSince(nowMs - Number(relative[1]) * unitMs, nowMs);
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return nowMs - DEFAULT_WINDOW_MS;
  return clampSince(parsed, nowMs);
}

/** A future window returns nothing, and nothing reads as "nothing changed". */
function clampSince(sinceMs: number, nowMs: number): number {
  return Math.min(Math.max(sinceMs, MIN_SINCE_MS), nowMs);
}

function parseLimit(limit: unknown): number | ChangesReadFailure {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const value = typeof limit === 'string' ? Number(limit.trim()) : limit;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return invalid(`limit must be a positive whole number, got: ${String(limit)}`);
  }
  return Math.min(value, MAX_LIMIT);
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T | undefined | ChangesReadFailure {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  // Silently returning zero rows for a misspelt filter is the worst answer available:
  // it is indistinguishable from "nothing changed".
  return invalid(`${field} must be one of ${allowed.join(', ')}, got: ${String(value)}`);
}

function invalid(error: string): ChangesReadFailure {
  return { success: false, code: 'invalid_argument', error };
}

function isChangesFailure(value: unknown): value is ChangesReadFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { success?: unknown }).success === false
  );
}

export function readChanges(
  ledger: ChangesLedger,
  input: ChangesReadInput,
  nowMs: number
): ChangesReadResult | ChangesReadFailure {
  const limit = parseLimit(input.limit);
  if (isChangesFailure(limit)) return limit;
  const targetType = parseEnum(input.target_type, CHANGES_READ_TARGET_TYPES, 'target_type');
  if (isChangesFailure(targetType)) return targetType;
  const causeState = parseEnum(input.cause_state, CHANGES_READ_CAUSE_STATES, 'cause_state');
  if (isChangesFailure(causeState)) return causeState;

  const sinceMs = parseChangesSince(input.since, nowMs);
  // Coverage is the cause_state breakdown, so it answers within the SAME target scope the
  // rows were drawn from. It deliberately ignores cause_state: filtering the breakdown by
  // one of its own terms would report a zero that only means "I asked for the other one".
  const coverage = ledger.changeCoverage(sinceMs, targetType);
  const matching = coverage.attributed + coverage.unattributed;
  const total =
    causeState === undefined
      ? matching
      : causeState === 'attributed'
        ? coverage.attributed
        : coverage.unattributed;

  const changes = ledger.listChanges({ sinceMs, targetType, causeState, limit });

  return {
    success: true,
    coverage,
    since: new Date(sinceMs).toISOString(),
    total,
    returned: changes.length,
    changes: changes.map((change) => ({
      effect_id: change.id,
      kind: change.kind,
      target_type: change.targetType,
      target_id: change.targetId,
      cause_state: change.causeState,
      cause_kind: change.causeKind,
      source_event_ids: change.sourceEventIds,
      channel: change.channelId,
      run_id: change.runId,
      at: new Date(change.atMs).toISOString(),
    })),
  };
}
