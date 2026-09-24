#!/usr/bin/env node
'use strict';
/**
 * Public stdio MCP adapter for the common runtime client (no SDK dependency).
 *
 * The model-facing door into the unified action surface. tools/list is the
 * catalog's own describe over the runtime socket; tools/call is one
 * client.call on the same socket — catalog → dispatch → knowledge/runtime,
 * never a second execution path and never a direct database.
 *
 * Authority is the daemon-issued session credential under MAMA_HOME, re-read
 * per call so a credential rotation denies the next call instead of pinning a
 * stale one. The credential never appears in tool output.
 *
 * MCP servers must use stderr for logging (stdout = JSON-RPC).
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const readline = require('node:readline');
const { createClient } = require('@jungjaehoon/mama-core/client/client');
const log = (msg) => {
  process.stderr.write(`[mama-action-mcp] ${msg}\n`);
};
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'mama', version: '0.1.0' };
function mamaHome() {
  const home = process.env.MAMA_HOME?.trim();
  if (!home) {
    throw new Error('MAMA_HOME is not set — the action server cannot locate the runtime socket');
  }
  return home;
}
function sessionCredential(home) {
  const credentialPath = join(home, 'session-credential');
  if (!existsSync(credentialPath)) {
    return undefined;
  }
  const credential = readFileSync(credentialPath, 'utf8').trim();
  return credential === '' ? undefined : credential;
}
function runtimeClient(home) {
  return createClient({
    socketPath: join(home, 'runtime.sock'),
    journalPath: join(home, 'runtime', 'client-journal.jsonl'),
    credential: sessionCredential(home),
  });
}
function describeTool(contract) {
  const examples = (contract.examples ?? [])
    .map((example) => `- ${example.title}: ${JSON.stringify(example.input)}`)
    .join('\n');
  return {
    name: contract.name,
    description: examples ? `${contract.summary}\nExamples:\n${examples}` : contract.summary,
    inputSchema: contract.inputSchema,
  };
}
function resultContent(result) {
  if (result.status === 'completed') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, data: result.data ?? null }),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          status: result.status,
          error: result.error ?? null,
          ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
        }),
      },
    ],
    isError: true,
  };
}
async function callTool(client, params) {
  const name = params.name;
  if (typeof name !== 'string' || name.length === 0) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ success: false, error: 'missing tool name' }) },
      ],
      isError: true,
    };
  }
  const input = params.arguments ?? {};
  try {
    const result = await client.call({ action: name, input });
    return resultContent(result);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}
/**
 * One JSON-RPC request → one MCP response (null for notifications). The client
 * dependency is the only socket handle — the handler never opens its own.
 */
async function handleRequest(request, deps) {
  const id = request.id;
  const reply = (result) => ({ jsonrpc: '2.0', id: id ?? 0, result });
  const fail = (code, message) => ({
    jsonrpc: '2.0',
    id: id ?? 0,
    error: { code, message },
  });
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
    case 'tools/list': {
      const contracts = await deps.client.describe();
      return reply({ tools: contracts.map(describeTool) });
    }
    case 'tools/call':
      return reply(await callTool(deps.client, request.params ?? {}));
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (id === undefined) {
        return null;
      }
      return fail(-32601, `Method not found: ${request.method}`);
  }
}
async function runStdioMcpServer() {
  const home = mamaHome();
  log(`starting — MAMA_HOME=${home}`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32700, message: 'Parse error' },
        })}\n`
      );
      return;
    }
    void handleRequest(request, { client: runtimeClient(home) })
      .then((response) => {
        if (response !== null) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      })
      .catch((error) => {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id ?? 0,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          })}\n`
        );
      });
  });
}
module.exports = { handleRequest, runStdioMcpServer };
// The public package bin can spawn this file directly; importing the adapter
// from another client has no side effects.
const invokedAs = process.argv[1] ?? '';
if (/action-server\.js$/.test(invokedAs)) {
  runStdioMcpServer().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
