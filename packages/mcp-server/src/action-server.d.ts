import type { Client } from '@jungjaehoon/mama-core/client/client';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

export function handleRequest(
  request: JsonRpcRequest,
  deps: { client: Client }
): Promise<JsonRpcResponse | null>;

export function runStdioMcpServer(): Promise<void>;
