/**
 * Client — the one caller-side library for CLI and MCP.
 *
 * §291: the client issues the operationId for a call and writes it to the
 * journal — action plus payload hash — BEFORE the request is sent, so a retry
 * always names the same id. For knowledge commands that id is the commandId;
 * an input carrying a different commandId conflicts before anything writes.
 *
 * §297: a confirmed failure is `failed`; a transport break after the request
 * may have committed is `unknown` and keeps the original operationId. A
 * disconnected call is never reported as unsaved.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActionContract, ActionResult, ClientSessionFacts } from '../action-contracts.js';
import { canonicalizeJSON } from '../canonicalize.js';
import { IpcTransportError, newRequestId, sendIpcRequest } from './ipc.js';

export interface ClientOptions {
  /** The private socket the runtime owns. No path guessing — product assembly states it. */
  socketPath: string;
  /**
   * Append-only JSONL journal of issued operations: {at, operationId, action,
   * payloadHash}. Written before send; a failed write fails the call closed,
   * because an operation without a recovery record must not run.
   */
  journalPath: string;
  /** Opaque session credential; the server resolves it to access. */
  credential?: string;
  /** Optional cap on one request; a timeout after connect reports `unknown`. */
  timeoutMs?: number;
}

export interface ClientCall {
  action: string;
  input?: unknown;
  session?: ClientSessionFacts;
  /** Reuse this id only to retransmit the same call. */
  operationId?: string;
}

export interface Client {
  /** Every contract the server executes — the whole callable surface. */
  describe(): Promise<ActionContract[]>;
  /** One contract by name or alias. */
  describe(name: string): Promise<ActionContract>;
  call(call: ClientCall): Promise<ActionResult>;
  /** The server's bound record of an issued operation. */
  getOperation(operationId: string): Promise<ActionResult>;
}

interface JournalEntry {
  at: string;
  operationId: string;
  action: string;
  payloadHash: string;
}

export function createClient(options: ClientOptions): Client {
  const journal = (entry: JournalEntry): void => {
    mkdirSync(dirname(options.journalPath), { recursive: true });
    appendFileSync(options.journalPath, `${JSON.stringify(entry)}\n`, 'utf8');
  };

  const payloadHash = (call: ClientCall, operationId: string): string =>
    createHash('sha256')
      .update(
        canonicalizeJSON(
          JSON.parse(
            JSON.stringify({ action: call.action, input: call.input ?? null, operationId })
          )
        )
      )
      .digest('hex');

  const call = async (request: ClientCall): Promise<ActionResult> => {
    const operationId = request.operationId ?? `op_${randomUUID()}`;

    const inputCommandId =
      typeof request.input === 'object' && request.input !== null
        ? (request.input as Record<string, unknown>).commandId
        : undefined;
    if (typeof inputCommandId === 'string' && inputCommandId !== operationId) {
      return {
        status: 'failed',
        operationId,
        error: {
          kind: 'invalid_input',
          code: 'COMMAND_CONFLICT',
          message:
            `input.commandId ${inputCommandId} disagrees with operationId ${operationId}: ` +
            'a call has exactly one command id — retransmit reuses it, a new call gets a new one',
        },
      };
    }

    try {
      journal({
        at: new Date().toISOString(),
        operationId,
        action: request.action,
        payloadHash: payloadHash(request, operationId),
      });
    } catch (error) {
      return {
        status: 'failed',
        operationId,
        error: {
          kind: 'internal',
          code: 'journal_write_failed',
          message: `operation journal write failed before send: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }

    let wire;
    try {
      wire = await sendIpcRequest(
        options.socketPath,
        {
          requestId: newRequestId(),
          kind: 'call',
          credential: options.credential,
          action: request.action,
          input: request.input,
          operationId,
          session: request.session,
        },
        { timeoutMs: options.timeoutMs }
      );
    } catch (error) {
      if (error instanceof IpcTransportError && error.phase === 'connect') {
        return {
          status: 'failed',
          operationId,
          error: {
            kind: 'internal',
            code: 'ipc_unavailable',
            message: `runtime socket unreachable: ${error.message}`,
          },
        };
      }
      return {
        status: 'unknown',
        operationId,
        error: {
          kind: 'internal',
          code: 'ipc_lost_response',
          message:
            `the answer was lost after the call may have committed — ` +
            `check operation.get(${operationId}) or resend the same operationId`,
        },
      };
    }

    if (!wire.ok) {
      return { status: 'failed', operationId, error: wire.error };
    }
    return wire.result as ActionResult;
  };

  const describe = async (name?: string): Promise<ActionContract[] | ActionContract> => {
    const wire = await sendIpcRequest(
      options.socketPath,
      {
        requestId: newRequestId(),
        kind: 'describe',
        credential: options.credential,
        name,
      },
      { timeoutMs: options.timeoutMs }
    );
    if (!wire.ok) {
      throw new Error(`describe failed: [${wire.error.code}] ${wire.error.message}`);
    }
    return wire.result as ActionContract[] | ActionContract;
  };

  return {
    describe: describe as Client['describe'],
    call,
    getOperation: (operationId) => call({ action: 'operation.get', input: { operationId } }),
  };
}
