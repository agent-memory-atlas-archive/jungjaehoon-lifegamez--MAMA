/**
 * The owner agent's door into the daemon's action catalog, spoken as stdio MCP
 * because that is how the CLI backends take tools.
 *
 * tools/list is the catalog's own describe over the runtime socket; tools/call
 * is one client.call on the same socket. No database, no second execution path.
 * The session credential is re-read per request, so a rotation denies the next
 * call instead of pinning a stale one; it never appears in tool output.
 *
 * MCP servers log to stderr (stdout is JSON-RPC).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import type { ActionContract, ActionResult } from '@jungjaehoon/mama-core';
import { createClient, type Client } from '@jungjaehoon/mama-core/client/client';

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

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'mama', version: '0.1.0' };

function log(message: string): void {
  process.stderr.write(`[mama-action-mcp] ${message}\n`);
}

function mamaHome(): string {
  const home = process.env.MAMA_HOME?.trim();
  if (!home) {
    throw new Error('MAMA_HOME is not set — the action server cannot locate the runtime socket');
  }
  return home;
}

function sessionCredential(home: string): string | undefined {
  const credentialPath = join(home, 'session-credential');
  if (!existsSync(credentialPath)) return undefined;
  const credential = readFileSync(credentialPath, 'utf8').trim();
  return credential === '' ? undefined : credential;
}

function runtimeClient(home: string): Client {
  return createClient({
    socketPath: join(home, 'runtime.sock'),
    journalPath: join(home, 'runtime', 'client-journal.jsonl'),
    credential: sessionCredential(home),
  });
}

function describeTool(contract: ActionContract) {
  const examples = (contract.examples ?? [])
    .map((example) => `- ${example.title}: ${JSON.stringify(example.input)}`)
    .join('\n');
  return {
    name: contract.name,
    description: examples ? `${contract.summary}\nExamples:\n${examples}` : contract.summary,
    inputSchema: contract.inputSchema,
  };
}

function textResult(value: unknown, isError: boolean): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function resultContent(result: ActionResult): ToolResult {
  if (result.status === 'completed') {
    return textResult({ success: true, data: result.data ?? null }, false);
  }
  return textResult(
    {
      success: false,
      status: result.status,
      error: result.error ?? null,
      ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
    },
    true
  );
}

async function callTool(client: Client, params: Record<string, unknown>): Promise<ToolResult> {
  const name = params.name;
  if (typeof name !== 'string' || name.length === 0) {
    return textResult({ success: false, error: 'missing tool name' }, true);
  }
  try {
    return resultContent(await client.call({ action: name, input: params.arguments ?? {} }));
  } catch (error) {
    return textResult(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true
    );
  }
}

/**
 * One JSON-RPC request → one MCP response (null for notifications). The client
 * dependency is the only socket handle; the handler never opens its own.
 */
export async function handleRequest(
  request: JsonRpcRequest,
  deps: { client: Client }
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? 0;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: (await deps.client.describe()).map(describeTool) });
    case 'tools/call':
      return reply(await callTool(deps.client, request.params ?? {}));
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (request.id === undefined) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}

function write(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export function runStdioMcpServer(): void {
  const home = mamaHome();
  log(`starting — MAMA_HOME=${home}`);
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: '2.0', id: 0, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void handleRequest(request, { client: runtimeClient(home) })
      .then((response) => {
        if (response !== null) write(response);
      })
      .catch((error: unknown) => {
        write({
          jsonrpc: '2.0',
          id: request.id ?? 0,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      });
  });
}

if (require.main === module) {
  try {
    runStdioMcpServer();
  } catch (error) {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
