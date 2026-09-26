import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { shellQuote } from './secrets.js';

export function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return undefined;
}

export function startScript(options: {
  home: string;
  nodePath: string;
  cliPath: string;
  executablePaths: string[];
  viewer: Record<string, string>;
}): string {
  const root = join(options.home, '.mama');
  const path = [
    ...new Set([
      dirname(options.nodePath),
      ...options.executablePaths.map(dirname),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]),
  ].join(':');
  return [
    '#!/bin/sh',
    'set -eu',
    'umask 077',
    `export PATH=${shellQuote(path)}`,
    `cd ${shellQuote(root)}`,
    'set -a',
    `. ${shellQuote(join(root, 'auth.env'))}`,
    'set +a',
    ...Object.entries(options.viewer).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `exec ${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)} daemon >> ${shellQuote(join(root, 'logs', 'daemon.log'))} 2>&1`,
    '',
  ].join('\n');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function launchAgent(home: string): string {
  const root = join(home, '.mama');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mama.server</string>
  <key>ProgramArguments</key><array><string>${xml(join(root, 'start.sh'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(root, 'logs', 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(root, 'logs', 'daemon.log'))}</string>
</dict></plist>
`;
}
