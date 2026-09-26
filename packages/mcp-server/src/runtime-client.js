/**
 * The MCP server's door into the running MAMA runtime — the same common
 * client the CLI uses, over the private action socket.
 *
 * This process owns no database and no embedding model: every tool call is an
 * action request on the socket the runtime mounted. Paths are product
 * assembly — stated here, never guessed inside core.
 *
 * @module runtime-client
 */

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@jungjaehoon/mama-core');

/**
 * The MAMA home this product talks to — the daemon's home, where the runtime
 * socket and this boot's session credential live. `MAMA_HOME` overrides the
 * `~/.mama` convention for tests and side-by-side profiles.
 */
function mamaHome() {
  if (process.env.MAMA_HOME) {
    return process.env.MAMA_HOME;
  }
  return join(process.env.HOME || '.', '.mama');
}

/**
 * The three paths a caller needs: the socket the runtime serves, the shared
 * caller-side operation journal, and this boot's session credential file.
 */
function runtimeClientPaths(home = mamaHome()) {
  return {
    socketPath: join(home, 'runtime.sock'),
    journalPath: join(home, 'runtime', 'client-journal.jsonl'),
    credentialPath: join(home, 'runtime', 'session-credential'),
  };
}

/**
 * A client bound to the current boot's credential. A missing credential file
 * is not an error here — the call it produces is denied, which is the honest
 * answer when the daemon has not issued a session.
 */
function openRuntimeClient(paths = runtimeClientPaths()) {
  const credential = existsSync(paths.credentialPath)
    ? readFileSync(paths.credentialPath, 'utf8').trim()
    : undefined;
  return createClient({
    socketPath: paths.socketPath,
    journalPath: paths.journalPath,
    credential: credential === '' ? undefined : credential,
  });
}

/**
 * Unwrap one action call to its data payload.
 *
 * A confirmed failure throws with the server's error code. A lost answer is
 * `unknown`, never "unsaved" — the thrown message names the operationId so a
 * caller can settle the call through operation.get instead of assuming the
 * write did not happen.
 */
async function callAction(client, action, input) {
  const result = await client.call({ action, input });
  if (result.status === 'completed') {
    return result.data;
  }
  const failure = result.error || {};
  const hint =
    failure.code === 'ipc_unavailable'
      ? ' — the MAMA runtime is not serving this socket; start it with `mama daemon`'
      : '';
  const error = new Error(
    `[${failure.code || result.status}] ${failure.message || 'action call failed'}${hint}`
  );
  error.code = failure.code;
  error.status = result.status;
  error.operationId = result.operationId;
  throw error;
}

module.exports = {
  mamaHome,
  runtimeClientPaths,
  openRuntimeClient,
  callAction,
};
