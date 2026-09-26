import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import {
  runStdioMcpServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../../src/runtime/action-mcp-server.js';

/** Real JSON-lines stdio handler and socket client, without a CLI subprocess. */
export function actionMcpSession() {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = createInterface({ input: output });
  const server = runStdioMcpServer({ input, output });
  let id = 0;
  return {
    async request(method: string, params?: JsonRpcRequest['params']): Promise<JsonRpcResponse> {
      const response = once(responses, 'line');
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
      const [line] = await response;
      return JSON.parse(line as string) as JsonRpcResponse;
    },
    close() {
      server.close();
      responses.close();
      input.destroy();
      output.destroy();
    },
  };
}
