/**
 * The owner agent's action MCP door: tools/list is catalog.describe over the
 * runtime socket, tools/call is one client.call. Carried from the archive's
 * handleRequest unit surface (tests/mcp/action-server.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { ActionContract, ActionResult } from '@jungjaehoon/mama-core';
import { resolveActionServerPath } from '../../src/cli/runtime/action-mcp-config.js';
import { handleRequest } from '../../src/runtime/action-mcp-server.js';

describe('mama action MCP server — handleRequest unit surface', () => {
  const contracts: ActionContract[] = [
    {
      name: 'work.create',
      summary: 'Create a work item',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
      examples: [{ title: 'one', input: { topic: 'x' } }],
    } as ActionContract,
    {
      name: 'graph.query',
      summary: 'Query the graph',
      inputSchema: { type: 'object' },
    } as ActionContract,
  ];
  const calls: Array<{ action: string; input?: unknown }> = [];
  const client = {
    describe: async (): Promise<ActionContract[]> => contracts,
    call: async (call: { action: string; input?: unknown }): Promise<ActionResult> => {
      calls.push(call);
      if (call.action === 'work.create') {
        return { status: 'completed', operationId: 'op_1', data: { commitmentId: 'c1' } };
      }
      return {
        status: 'failed',
        operationId: 'op_2',
        error: { kind: 'unknown_action', code: 'UNKNOWN', message: 'no such action' },
      };
    },
  };

  it('tools/list renders the catalog contracts verbatim — name, summary, schema', async () => {
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { client: client as never }
    );
    const tools = (response?.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('work.create');
    expect(tools[0].description).toContain('Create a work item');
    expect(tools[0].description).toContain('Examples:');
    expect(tools[0].inputSchema).toEqual(contracts[0].inputSchema);
    expect(tools[1].description).toBe('Query the graph');
  });

  it('tools/call is one client.call — the adapter executes nothing itself', async () => {
    const response = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'work.create', arguments: { topic: 't' } },
      },
      { client: client as never }
    );
    expect(calls).toEqual([{ action: 'work.create', input: { topic: 't' } }]);
    const content = (response?.result as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0].text)).toEqual({
      success: true,
      data: { commitmentId: 'c1' },
    });
    expect((response?.result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('a failed action result is success:false + isError — never a silent pass', async () => {
    const response = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory.delete', arguments: {} },
      },
      { client: client as never }
    );
    const result = response?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('failed');
    expect((payload.error as { code: string }).code).toBe('UNKNOWN');
  });

  it('a missing tool name fails closed; notifications get no reply', async () => {
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} },
      { client: client as never }
    );
    expect((response?.result as { isError?: boolean }).isError).toBe(true);
    const silent = await handleRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { client: client as never }
    );
    expect(silent).toBeNull();
  });
});

describe('mama action MCP server — location', () => {
  it('is the standalone build output, not another package', () => {
    expect(resolveActionServerPath()).toMatch(/[/\\]runtime[/\\]action-mcp-server\.js$/);
  });
});
