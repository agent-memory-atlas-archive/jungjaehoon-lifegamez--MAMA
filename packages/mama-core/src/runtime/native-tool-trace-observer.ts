import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../db-manager.js';
import { appendToolTrace } from './tool-trace-store.js';
import type { NativeEffectObserver } from './native-effect-observer.js';
import { traceSummary } from './trace-summary.js';

/** Native harness notifications are observations; persistence never authorizes execution. */
export function createNativeToolTraceObserver(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  modelRunId: string
): NativeEffectObserver {
  const calls = new Map<string, { traceId: string; startedAt: number; settled: boolean }>();
  let warned = false;
  const failed = () => {
    if (!warned) console.warn('[NativeToolTrace] observation storage failed');
    warned = true;
  };
  const settle = (callId: string, status: 'completed' | 'failed' | 'unknown') => {
    const call = calls.get(callId);
    if (!call || call.settled) return;
    try {
      adapter
        .prepare('UPDATE tool_traces SET execution_status = ?, duration_ms = ? WHERE trace_id = ?')
        .run(status, Math.max(0, Date.now() - call.startedAt), call.traceId);
      call.settled = status !== 'unknown';
    } catch {
      failed();
    }
  };
  return {
    started(name, input) {
      const callId =
        typeof input.nativeToolUseId === 'string' ? input.nativeToolUseId : randomUUID();
      if (calls.has(callId)) return;
      const call = {
        traceId: `tr_${randomUUID().replace(/-/g, '')}`,
        startedAt: Date.now(),
        settled: false,
      };
      calls.set(callId, call);
      void appendToolTrace(adapter, {
        trace_id: call.traceId,
        model_run_id: modelRunId,
        gateway_call_id: callId,
        tool_name: name,
        input_summary: traceSummary(input),
        execution_status: 'running',
        duration_ms: 0,
        created_at: call.startedAt,
      }).catch(failed);
    },
    settled(_name, callId, isError, outcome) {
      settle(callId, outcome ?? (isError ? 'failed' : 'completed'));
    },
    interrupted() {
      for (const callId of calls.keys()) settle(callId, 'unknown');
    },
    finished() {
      for (const callId of calls.keys()) settle(callId, 'unknown');
    },
  };
}
