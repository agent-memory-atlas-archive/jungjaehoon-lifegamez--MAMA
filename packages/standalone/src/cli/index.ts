#!/usr/bin/env node

import { ConfigError } from '../runtime/config.js';
import { CliInputError } from './prompt.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'init') {
    if (process.argv.length !== 3) throw new CliInputError('Usage: mama init');
    const { runInit } = await import('./commands/init.js');
    await runInit();
    return;
  }
  if (command === 'secret') {
    const { runSecret } = await import('./commands/secret.js');
    await runSecret(process.argv.slice(3));
    return;
  }
  if (command === 'daemon') {
    const { runDaemon } = await import('./commands/daemon.js');
    await runDaemon();
    return;
  }
  if (command === 'replay') {
    const { runReplay } = await import('./commands/replay.js');
    await runReplay();
    return;
  }
  if (command === 'status') {
    const { daemonStatus } = await import('./commands/daemon.js');
    console.log(daemonStatus());
    return;
  }
  if (command === 'stop') {
    const { requestDaemonStop } = await import('./commands/daemon.js');
    requestDaemonStop();
    return;
  }
  console.log(
    'Usage: mama init | secret set <NAME> | secret list | daemon | replay | status | stop'
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof CliInputError || error instanceof ConfigError
      ? error.message
      : 'mama command failed'
  );
  process.exitCode = 1;
});
