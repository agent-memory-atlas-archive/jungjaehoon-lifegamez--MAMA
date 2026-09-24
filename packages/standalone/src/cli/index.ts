#!/usr/bin/env node

import { daemonStatus, requestDaemonStop, runDaemon } from './commands/daemon.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'daemon') {
    await runDaemon();
    return;
  }
  if (command === 'status') {
    console.log(daemonStatus());
    return;
  }
  if (command === 'stop') {
    requestDaemonStop();
    return;
  }
  console.log('Usage: mama daemon | status | stop');
}

void main().catch(() => {
  console.error('daemon failed');
  process.exitCode = 1;
});
