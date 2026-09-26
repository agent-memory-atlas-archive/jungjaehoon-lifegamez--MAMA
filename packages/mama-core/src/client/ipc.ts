/**
 * IPC — the private Unix-socket wire between CLI/MCP clients and the runtime.
 *
 * §4.3: the socket carries requestId, action, input and the current session
 * credential. Frames are length-prefixed JSON; partial reads, oversized frames
 * and disconnects are handled explicitly. A lost answer is never an empty
 * result — whether a mutation landed is settled through operation.get, not by
 * guessing from a broken socket.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { ActionFailure, ActionSessionFacts, ClientSessionFacts } from '../action-contracts.js';
import type { ActionCatalog } from '../api/catalog.js';
import type { ActionDispatcher } from '../api/dispatch.js';
import type { JudgmentAccess } from '../knowledge/judgments.js';

/** Frames larger than this are refused rather than buffered. */
export const IPC_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const FRAME_HEADER_BYTES = 4;

export interface IpcRequest {
  /** Wire-level correlation id; distinct from operationId, which is the semantic command id. */
  requestId: string;
  kind: 'call' | 'describe';
  /** Opaque session credential — the server maps it to access; input never grants access. */
  credential?: string;
  /** kind === 'describe': one contract name; absent lists the whole surface. */
  name?: string;
  /** kind === 'call': */
  action?: string;
  input?: unknown;
  operationId?: string;
  session?: ClientSessionFacts;
}

export type IpcResponse =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: ActionFailure };

/**
 * A transport break. `connect` means the request provably never reached the
 * runtime — the call can be reported `failed`. `exchange` means it may have
 * been delivered — the honest status is `unknown` until operation.get or a
 * same-id resend settles it.
 */
export class IpcTransportError extends Error {
  readonly phase: 'connect' | 'exchange';
  constructor(phase: 'connect' | 'exchange', message: string) {
    super(message);
    this.name = 'IpcTransportError';
    this.phase = phase;
  }
}

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > IPC_MAX_FRAME_BYTES) {
    throw new IpcTransportError(
      'exchange',
      `frame of ${body.length} bytes exceeds the ${IPC_MAX_FRAME_BYTES}-byte cap`
    );
  }
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/** Reassembles a byte stream into whole frame bodies; partial tails stay buffered. */
class FrameReader {
  private buffered: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const frames: Buffer[] = [];
    while (this.buffered.length >= FRAME_HEADER_BYTES) {
      const length = this.buffered.readUInt32BE(0);
      if (length > this.maxFrameBytes) {
        throw new Error(`frame length ${length} exceeds the ${this.maxFrameBytes}-byte cap`);
      }
      if (this.buffered.length < FRAME_HEADER_BYTES + length) {
        return frames;
      }
      frames.push(this.buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length));
      this.buffered = this.buffered.subarray(FRAME_HEADER_BYTES + length);
    }
    return frames;
  }
}

/** One request over one connection — matches the short-lived CLI/MCP caller lifecycle. */
export function sendIpcRequest(
  socketPath: string,
  request: IpcRequest,
  options: { timeoutMs?: number } = {}
): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    const socket = createConnection(socketPath);
    const reader = new FrameReader(IPC_MAX_FRAME_BYTES);

    const settle = (complete: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      complete();
    };

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            settle(() =>
              reject(
                new IpcTransportError(
                  connected ? 'exchange' : 'connect',
                  `ipc request timed out after ${options.timeoutMs}ms`
                )
              )
            );
          }, options.timeoutMs);

    socket.once('connect', () => {
      connected = true;
      socket.write(encodeFrame(request), (error?: Error | null) => {
        if (error) {
          settle(() =>
            reject(new IpcTransportError('exchange', `ipc write failed: ${error.message}`))
          );
        }
      });
    });

    socket.on('data', (chunk) => {
      let bodies: Buffer[];
      try {
        bodies = reader.push(chunk);
      } catch (error) {
        settle(() =>
          reject(
            new IpcTransportError(
              'exchange',
              `malformed response stream: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        );
        return;
      }
      for (const body of bodies) {
        let response: IpcResponse;
        try {
          response = JSON.parse(body.toString('utf8')) as IpcResponse;
        } catch {
          settle(() => reject(new IpcTransportError('exchange', 'response frame is not JSON')));
          return;
        }
        if (response.requestId !== request.requestId) {
          settle(() =>
            reject(
              new IpcTransportError(
                'exchange',
                `response requestId ${response.requestId} does not match request ${request.requestId}`
              )
            )
          );
          return;
        }
        settle(() => resolve(response));
        return;
      }
    });

    socket.once('error', (error) => {
      settle(() =>
        reject(
          new IpcTransportError(
            connected ? 'exchange' : 'connect',
            `ipc socket error: ${error.message}`
          )
        )
      );
    });

    socket.once('close', () => {
      settle(() =>
        reject(
          new IpcTransportError(
            connected ? 'exchange' : 'connect',
            'ipc socket closed before a complete response frame'
          )
        )
      );
    });

    void timer;
  });
}

export interface ActionIpcServerOptions {
  socketPath: string;
  catalog: ActionCatalog;
  dispatch: ActionDispatcher;
  /**
   * Maps the wire credential to call authority. A credential that cannot be
   * resolved is denied — the throw never reaches the action.
   */
  resolveAccess: (credential: string | undefined) => JudgmentAccess;
  /**
   * Host-stated call-site facts for calls on this socket — composed from the
   * resolved authority and the request, never from caller input. A fact the
   * socket cannot truthfully state (per-turn run, batch, channel) stays
   * absent.
   */
  sessionFacts?: (access: JudgmentAccess, request: IpcRequest) => ActionSessionFacts | undefined;
  maxFrameBytes?: number;
  /**
   * When the socket path already exists: probe it. A live socket is an error —
   * a dead file left by a crashed process is unlinked and reclaimed.
   */
  reclaimStaleSocket?: boolean;
}

/** True when the path exists but nothing answers — a dead file, safe to replace. */
export function staleSocketFile(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const probe = createConnection(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', () => resolve(true));
  });
}

export interface ActionIpcServer {
  socketPath: string;
  close(): Promise<void>;
}

async function handleFrame(
  socket: Socket,
  options: ActionIpcServerOptions,
  body: Buffer
): Promise<void> {
  let request: IpcRequest;
  try {
    request = JSON.parse(body.toString('utf8')) as IpcRequest;
  } catch {
    socket.write(
      encodeFrame({
        requestId: '',
        ok: false,
        error: {
          kind: 'invalid_input',
          code: 'malformed_frame',
          message: 'request frame is not JSON',
        },
      } satisfies IpcResponse)
    );
    return;
  }

  const reply = (response: IpcResponse): void => {
    socket.write(encodeFrame(response));
  };

  let access: JudgmentAccess;
  try {
    access = options.resolveAccess(request.credential);
  } catch (error) {
    reply({
      requestId: request.requestId,
      ok: false,
      error: {
        kind: 'denied',
        code: 'access_denied',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  try {
    let result: unknown;
    if (request.kind === 'describe') {
      result =
        request.name === undefined
          ? options.catalog.list()
          : options.catalog.describe(request.name);
    } else if (request.kind === 'call') {
      if (typeof request.action !== 'string' || request.action.length === 0) {
        reply({
          requestId: request.requestId,
          ok: false,
          error: {
            kind: 'invalid_input',
            code: 'missing_action',
            message: 'call request requires action',
          },
        });
        return;
      }
      const session = options.sessionFacts?.(access, request);
      result = await options.dispatch(
        { action: request.action, input: request.input, operationId: request.operationId },
        session === undefined ? { access } : { access, session }
      );
    } else {
      reply({
        requestId: request.requestId,
        ok: false,
        error: {
          kind: 'invalid_input',
          code: 'unknown_request_kind',
          message: `unknown request kind ${String(request.kind)}`,
        },
      });
      return;
    }
    reply({ requestId: request.requestId, ok: true, result });
  } catch (error) {
    reply({
      requestId: request.requestId,
      ok: false,
      error: {
        kind: 'internal',
        code: error instanceof Error ? error.name : 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * The server half of the IPC contract — the piece `runtime.start` mounts when
 * it opens the socket. One connection per caller, frames handled in order.
 */
export function createActionIpcServer(options: ActionIpcServerOptions): Promise<ActionIpcServer> {
  const maxFrameBytes = options.maxFrameBytes ?? IPC_MAX_FRAME_BYTES;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    const reader = new FrameReader(maxFrameBytes);
    socket.on('data', (chunk) => {
      let bodies: Buffer[];
      try {
        bodies = reader.push(chunk);
      } catch (error) {
        socket.write(
          encodeFrame({
            requestId: '',
            ok: false,
            error: {
              kind: 'invalid_input',
              code: 'frame_too_large',
              message: error instanceof Error ? error.message : String(error),
            },
          } satisfies IpcResponse)
        );
        socket.end();
        return;
      }
      for (const body of bodies) {
        void handleFrame(socket, options, body);
      }
    });
  });

  return new Promise((resolve, reject) => {
    const handle: ActionIpcServer = {
      socketPath: options.socketPath,
      close: () =>
        new Promise<void>((done) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => {
            rmSync(options.socketPath, { force: true });
            done();
          });
        }),
    };
    const listen = (): void => {
      server.once('error', reject);
      server.listen(options.socketPath, () => resolve(handle));
    };
    if (!options.reclaimStaleSocket || !existsSync(options.socketPath)) {
      listen();
      return;
    }
    void staleSocketFile(options.socketPath).then((stale) => {
      if (!stale) {
        reject(new Error(`ipc socket already served by a live runtime: ${options.socketPath}`));
        return;
      }
      rmSync(options.socketPath, { force: true });
      listen();
    });
  });
}

/** Convenience for callers that only need a correlation id for the wire. */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}
