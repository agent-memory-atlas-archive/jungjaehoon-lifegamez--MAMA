import { randomUUID } from 'node:crypto';
import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type { NativeInputDispatch, NativeInputReceipt } from './drivers/types.js';
import type { NativeTurnResult } from './native-turn.js';
import type { StimulusKind } from './mailbox.js';

type NativeTurnResultPayload = Pick<
  NativeTurnResult,
  | 'response'
  | 'turns'
  | 'totalUsage'
  | 'stopReason'
  | 'modelRunId'
  | 'modelRunProvenance'
  | 'stoppedBy'
> & { ownerJournalProvenance?: 'commit_failed' };

export type NativeTurnResultRecord = NativeTurnResultPayload & {
  primaryStimulusId: string;
  /** Null only for historical results whose primary mailbox row was already pruned. */
  primaryKind: StimulusKind | null;
};

function resultRecord(value: unknown): NativeTurnResultPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native turn result is not an object');
  }
  const record = value as Record<string, unknown>;
  const usage = record.totalUsage as Record<string, unknown> | undefined;
  if (
    typeof record.response !== 'string' ||
    !Number.isSafeInteger(record.turns) ||
    Number(record.turns) < 0 ||
    !usage ||
    typeof usage.input_tokens !== 'number' ||
    !Number.isFinite(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    typeof usage.output_tokens !== 'number' ||
    !Number.isFinite(usage.output_tokens) ||
    usage.output_tokens < 0 ||
    ['cache_creation_input_tokens', 'cache_read_input_tokens', 'cost_usd'].some(
      (key) =>
        usage[key] !== undefined &&
        (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || Number(usage[key]) < 0)
    ) ||
    typeof record.stopReason !== 'string' ||
    (record.modelRunId !== null && typeof record.modelRunId !== 'string') ||
    !['available', 'backend_no_run', 'commit_failed'].includes(String(record.modelRunProvenance)) ||
    (record.modelRunProvenance === 'available' &&
      (typeof record.modelRunId !== 'string' || !record.modelRunId.trim())) ||
    (record.modelRunProvenance !== 'available' && record.modelRunId !== null) ||
    (record.stoppedBy !== undefined && typeof record.stoppedBy !== 'string') ||
    (record.ownerJournalProvenance !== undefined &&
      record.ownerJournalProvenance !== 'commit_failed')
  ) {
    throw new Error('Native turn result is invalid');
  }
  return {
    response: record.response,
    turns: Number(record.turns),
    totalUsage: {
      input_tokens: Number(usage.input_tokens),
      output_tokens: Number(usage.output_tokens),
      ...(usage.cache_creation_input_tokens === undefined
        ? {}
        : { cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) }),
      ...(usage.cache_read_input_tokens === undefined
        ? {}
        : { cache_read_input_tokens: Number(usage.cache_read_input_tokens) }),
      ...(usage.cost_usd === undefined ? {} : { cost_usd: Number(usage.cost_usd) }),
    },
    stopReason: record.stopReason as NativeTurnResult['stopReason'],
    modelRunId: record.modelRunId as string | null,
    modelRunProvenance: record.modelRunProvenance as NativeTurnResult['modelRunProvenance'],
    ...(record.stoppedBy === undefined
      ? {}
      : { stoppedBy: record.stoppedBy as NativeTurnResult['stoppedBy'] }),
    ...(record.ownerJournalProvenance === 'commit_failed'
      ? { ownerJournalProvenance: 'commit_failed' as const }
      : {}),
  };
}

export interface NativeDeliveryRecord {
  invocationId: string | null;
  state: 'prepared' | 'dispatching' | 'accepted' | 'settled' | 'uncertain';
  dispatch: NativeInputDispatch | null;
  receipt: NativeInputReceipt | null;
  error: string | null;
}

function address(
  value: unknown
): asserts value is { backend: 'claude' | 'codex'; sessionId: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    !['claude', 'codex'].includes(String((value as { backend?: unknown }).backend)) ||
    typeof (value as { sessionId?: unknown }).sessionId !== 'string' ||
    !(value as { sessionId: string }).sessionId.trim()
  ) {
    throw new Error('Native input address is invalid');
  }
}
function required(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Native input identity is required');
  }
}

/** One durable dispatch identity per accepted input. No task meaning or effect classification. */
export class NativeInputJournal {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => number = Date.now
  ) {
    const existed = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='native_input_deliveries'"
      )
      .get();
    db.exec(`CREATE TABLE IF NOT EXISTS native_input_deliveries (
      input_id INTEGER PRIMARY KEY REFERENCES mailbox_inputs(id) ON DELETE CASCADE,
      invocation_id TEXT UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('prepared','dispatching','accepted','settled','uncertain')),
      dispatch_json TEXT, receipt_json TEXT, error TEXT, updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS native_turn_results (
      receipt_json TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      primary_stimulus_id TEXT NOT NULL,
      primary_kind TEXT CHECK (primary_kind IS NULL OR primary_kind IN
        ('owner_message','source_delta','scheduled','native_event')),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (receipt_json, principal_id)
    )`);
    if (!existed) {
      db.exec(`INSERT OR IGNORE INTO native_input_deliveries (input_id,state,error,updated_at)
      SELECT id,'uncertain','Legacy input has no native dispatch record',created_at
      FROM mailbox_inputs WHERE status='claimed' OR (status='pending' AND attempts>0)`);
    }
  }

  get(inputId: number): NativeDeliveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM native_input_deliveries WHERE input_id=?')
      .get(inputId) as
      | {
          invocation_id: string | null;
          state: NativeDeliveryRecord['state'];
          dispatch_json: string | null;
          receipt_json: string | null;
          error: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const dispatch =
      row.dispatch_json === null ? null : (JSON.parse(row.dispatch_json) as NativeInputDispatch);
    const receipt =
      row.receipt_json === null ? null : (JSON.parse(row.receipt_json) as NativeInputReceipt);
    if (row.dispatch_json !== null) {
      address(dispatch);
      required(dispatch.inputId);
    }
    if (row.receipt_json !== null) {
      address(receipt);
      required(receipt.backend === 'claude' ? receipt.inputId : receipt.turnId);
    }
    if (dispatch && dispatch.inputId !== row.invocation_id) {
      throw new Error('Stored native input identity mismatch');
    }
    if (
      receipt &&
      (!dispatch ||
        receipt.backend !== dispatch.backend ||
        receipt.sessionId !== dispatch.sessionId ||
        (receipt.backend === 'claude' && receipt.inputId !== row.invocation_id))
    ) {
      throw new Error('Stored native receipt identity mismatch');
    }
    if (row.state === 'accepted' && !receipt) {
      throw new Error('Accepted native input has no receipt');
    }
    if (row.state === 'dispatching' && !dispatch) {
      throw new Error('Dispatched native input has no address');
    }
    return {
      invocationId: row.invocation_id,
      state: row.state,
      dispatch,
      receipt,
      error: row.error,
    };
  }

  /** Page the inputs that share one exact native receipt under one principal. */
  listByReceipt(
    receipt: NativeInputReceipt,
    principalId: string,
    options: { afterId?: number; limit?: number } = {}
  ): { inputIds: number[]; nextCursor: number | null } {
    address(receipt);
    required(receipt.backend === 'codex' ? receipt.turnId : receipt.inputId);
    required(principalId);
    const afterId = options.afterId ?? 0;
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new Error('Native receipt cursor must be a non-negative integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Native receipt page limit must be 1 to 100');
    }
    const rows = this.db
      .prepare(
        `SELECT n.input_id FROM native_input_deliveries n
         JOIN mailbox_inputs m ON m.id=n.input_id
         WHERE n.receipt_json=? AND m.principal_id=? AND n.input_id>?
         ORDER BY n.input_id LIMIT ?`
      )
      .all(canonicalizeJSON(receipt), principalId, afterId, limit + 1) as Array<{
      input_id: number;
    }>;
    const page = rows.slice(0, limit);
    return {
      inputIds: page.map((row) => row.input_id),
      nextCursor: rows.length > limit ? page[page.length - 1].input_id : null,
    };
  }

  /** One immutable final result per native turn, written before any consumer reply. */
  storeResult(inputId: number, result: NativeTurnResult): void {
    const native = this.get(inputId);
    if (!native?.receipt) throw new Error('Native result requires an accepted input receipt');
    const mailbox = this.db
      .prepare('SELECT stimulus_id, principal_id, kind FROM mailbox_inputs WHERE id=?')
      .get(inputId) as
      | { stimulus_id: string; principal_id: string; kind: StimulusKind | null }
      | undefined;
    if (!mailbox) throw new Error('Native result input is missing');
    if (
      !['owner_message', 'source_delta', 'scheduled', 'native_event'].includes(String(mailbox.kind))
    ) {
      throw new Error('Native result input has no producer-stated kind');
    }
    const receiptJson = canonicalizeJSON(native.receipt);
    const resultJson = canonicalizeJSON(resultRecord(result));
    this.db.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT primary_stimulus_id, primary_kind, result_json FROM native_turn_results WHERE receipt_json=? AND principal_id=?'
        )
        .get(receiptJson, mailbox.principal_id) as
        | { primary_stimulus_id: string; primary_kind: string | null; result_json: string }
        | undefined;
      if (existing) {
        if (
          existing.primary_stimulus_id !== mailbox.stimulus_id ||
          existing.primary_kind !== mailbox.kind ||
          existing.result_json !== resultJson
        ) {
          throw new Error('Native turn result conflicts with its durable receipt');
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO native_turn_results
           (receipt_json,principal_id,primary_stimulus_id,primary_kind,result_json,created_at)
           VALUES (?,?,?,?,?,?)`
        )
        .run(
          receiptJson,
          mailbox.principal_id,
          mailbox.stimulus_id,
          mailbox.kind,
          resultJson,
          this.now()
        );
    });
  }

  /** A later accepted input can recover the one final result under its principal. */
  resultForReceipt(
    receipt: NativeInputReceipt,
    principalId: string
  ): NativeTurnResultRecord | null {
    address(receipt);
    required(receipt.backend === 'codex' ? receipt.turnId : receipt.inputId);
    required(principalId);
    const row = this.db
      .prepare(
        'SELECT primary_stimulus_id, primary_kind, result_json FROM native_turn_results WHERE receipt_json=? AND principal_id=?'
      )
      .get(canonicalizeJSON(receipt), principalId) as
      | { primary_stimulus_id: string; primary_kind: string | null; result_json: string }
      | undefined;
    if (!row) return null;
    if (
      row.primary_kind !== null &&
      !['owner_message', 'source_delta', 'scheduled', 'native_event'].includes(row.primary_kind)
    ) {
      throw new Error('Stored native primary kind is invalid');
    }
    return {
      ...resultRecord(JSON.parse(row.result_json) as unknown),
      primaryStimulusId: row.primary_stimulus_id,
      primaryKind: row.primary_kind as StimulusKind | null,
    };
  }

  prepare(inputId: number): NativeDeliveryRecord {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO native_input_deliveries
      (input_id,invocation_id,state,updated_at) VALUES (?,?,'prepared',?)`
      )
      .run(inputId, randomUUID(), this.now());
    return this.get(inputId)!;
  }

  dispatch(inputId: number, value: NativeInputDispatch): void {
    address(value);
    required(value.inputId);
    const record = this.get(inputId);
    if (!record || record.invocationId !== value.inputId) {
      throw new Error('Native dispatch input identity mismatch');
    }
    const encoded = canonicalizeJSON(value);
    if (record.dispatch) {
      if (canonicalizeJSON(record.dispatch) !== encoded) {
        throw new Error('Native dispatch identity conflict');
      }
      throw new Error('Native input was already dispatched; reconciliation is required');
    }
    if (record.state !== 'prepared') {
      throw new Error('Native input requires reconciliation before dispatch');
    }
    const changed = this.db
      .prepare(
        "UPDATE native_input_deliveries SET state='dispatching',dispatch_json=?,updated_at=? WHERE input_id=? AND state='prepared'"
      )
      .run(encoded, this.now(), inputId);
    if (changed.changes !== 1) {
      throw new Error('Native input was already dispatched; reconciliation is required');
    }
  }

  accept(inputId: number, value: NativeInputReceipt): void {
    address(value);
    required(value.backend === 'claude' ? value.inputId : value.turnId);
    this.db.transaction(() => {
      const record = this.get(inputId);
      if (
        !record?.dispatch ||
        record.dispatch.backend !== value.backend ||
        record.dispatch.sessionId !== value.sessionId ||
        (value.backend === 'claude' && value.inputId !== record.invocationId)
      ) {
        throw new Error('Native receipt does not match the dispatched input');
      }
      if (record.receipt) {
        if (canonicalizeJSON(record.receipt) !== canonicalizeJSON(value)) {
          throw new Error('Native receipt identity conflict');
        }
        return;
      }
      this.db
        .prepare(
          "UPDATE native_input_deliveries SET state='accepted',receipt_json=?,error=NULL,updated_at=? WHERE input_id=?"
        )
        .run(canonicalizeJSON(value), this.now(), inputId);
      this.db
        .prepare("UPDATE mailbox_inputs SET status='acked',acked_at=? WHERE id=?")
        .run(this.now(), inputId);
    });
  }

  settle(inputId: number, reconciled = false): void {
    this.db.transaction(() => {
      const record = this.get(inputId);
      if (!record) {
        throw new Error('Native delivery record is missing');
      }
      if (record.state !== 'prepared' && !record.receipt && !reconciled) {
        throw new Error('Native input acknowledgement is unresolved');
      }
      this.db
        .prepare(
          "UPDATE native_input_deliveries SET state='settled',error=NULL,updated_at=? WHERE input_id=?"
        )
        .run(this.now(), inputId);
      this.db
        .prepare(
          "UPDATE mailbox_inputs SET status='acked',acked_at=COALESCE(acked_at,?) WHERE id=?"
        )
        .run(this.now(), inputId);
    });
  }

  uncertain(inputId: number, error: string): void {
    this.db
      .prepare(
        "UPDATE native_input_deliveries SET state='uncertain',error=?,updated_at=? WHERE input_id=? AND state!='settled' AND (state!='uncertain' OR error IS NOT ?)"
      )
      .run(error.slice(0, 500), this.now(), inputId, error.slice(0, 500));
  }

  pending(limit: number, afterId = 0): number[] {
    return (
      this.db
        .prepare(
          "SELECT input_id FROM native_input_deliveries WHERE state IN ('dispatching','accepted','uncertain') AND input_id>? ORDER BY input_id LIMIT ?"
        )
        .all(afterId, limit) as Array<{ input_id: number }>
    ).map((row) => row.input_id);
  }
}
