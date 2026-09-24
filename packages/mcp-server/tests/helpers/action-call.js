/**
 * Test helper: a `call` function backed by the real action catalog.
 *
 * The MCP tools and server handlers now speak one protocol — `call(action,
 * input)` resolving to the action's data payload. Tests that used to bind a
 * raw adapter bind this instead: the same catalog → dispatch → knowledge
 * path the socket serves, over the test database.
 *
 * @module tests/helpers/action-call
 */

import { randomUUID } from 'node:crypto';
import {
  createCatalog,
  coreActionRegistrations,
  createDispatcher,
  createKnowledge,
} from '@jungjaehoon/mama-core';

/**
 * The authority the test caller stands on. One fixed principal+agent and one
 * admitted project scope — writes and reads share it, so records a test saves
 * are the records its searches can see. A tool request naming another scope
 * is denied, exactly as a socket caller outside its grant would be.
 */
export const TEST_ACCESS = {
  principalId: 'principal-mcp-test',
  agentId: 'agent-mcp-test',
  scopes: [{ kind: 'project', id: 'scope-mcp-test' }],
};

/**
 * Build `call(action, input)` over a real dispatcher on `adapter`.
 * Mirrors runtime-client.callAction: a confirmed failure throws with the
 * server's error code, never a synthesized empty success.
 */
export function createActionCall(adapter, access = TEST_ACCESS) {
  const knowledge = createKnowledge({ adapter });
  const catalog = createCatalog(coreActionRegistrations(knowledge, adapter));
  const dispatch = createDispatcher(catalog);
  // Dispatch compares every call against the principal's grant. The test
  // principal is granted the catalog it was just handed — the same statement
  // boot makes for the owner — unless the caller states a narrower one.
  const granted =
    access.actions === undefined
      ? { ...access, actions: catalog.list().map((contract) => contract.name) }
      : access;
  return async (action, input) => {
    const result = await dispatch(
      { action, input, operationId: `test-op-${randomUUID()}` },
      { access: granted }
    );
    if (result.status === 'completed') {
      return result.data;
    }
    const failure = result.error || {};
    const error = new Error(
      `[${failure.code || result.status}] ${failure.message || 'action call failed'}`
    );
    error.code = failure.code;
    error.status = result.status;
    error.operationId = result.operationId;
    throw error;
  };
}
