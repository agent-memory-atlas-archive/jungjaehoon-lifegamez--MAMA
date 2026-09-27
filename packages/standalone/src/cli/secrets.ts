import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CliInputError, nonblankLine } from './prompt.js';

export const SECRET_NAMES = [
  'MAMA_TELEGRAM_TOKEN',
  'MAMA_TELEGRAM_SOURCE_TOKEN',
  'MAMA_SLACK_TOKEN',
  'MAMA_SLACK_APP_TOKEN',
  'MAMA_CHATWORK_TOKEN',
  'MAMA_DISCORD_TOKEN',
  'MAMA_NOTION_TOKEN',
  'MAMA_TRELLO_KEY',
  'MAMA_TRELLO_TOKEN',
  'MAMA_AUTH_TOKEN',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number] | `MAMA_ICAL_URL_${string}`;

function isIcalSecret(name: string | undefined): name is `MAMA_ICAL_URL_${string}` {
  return typeof name === 'string' && /^MAMA_ICAL_URL_[A-Z][A-Z0-9_]*$/.test(name);
}

export function secretName(name: string | undefined): SecretName {
  if (!(SECRET_NAMES as readonly (string | undefined)[]).includes(name) && !isIcalSecret(name)) {
    throw new CliInputError(`Allowed secret names: ${SECRET_NAMES.join(', ')}`);
  }
  return name as SecretName;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function authSource(home: string): string {
  try {
    return readFileSync(join(home, '.mama', 'auth.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new CliInputError('Cannot read auth.env. Check its owner and permissions.');
  }
}

function assignmentName(line: string): string | undefined {
  return /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
}

export function listSecrets(home: string): string[] {
  const names = authSource(home).split('\n').map(assignmentName);
  return [
    ...SECRET_NAMES.filter((name) => names.includes(name)),
    ...names.filter(isIcalSecret),
  ].sort();
}

/** Stage inside runtime/, which both owner backends deny reading, then atomically replace auth.env. */
export function updateSecrets(home: string, values: Partial<Record<SecretName, string>>): void {
  for (const [name, value] of Object.entries(values)) {
    secretName(name);
    if (typeof value !== 'string') throw new CliInputError(`${name} must have a value`);
    nonblankLine(value);
  }
  const original = authSource(home);
  const retained = original
    .split('\n')
    .filter((line) => !Object.hasOwn(values, assignmentName(line) ?? ''))
    .join('\n');
  const source = `${retained}${retained && !retained.endsWith('\n') ? '\n' : ''}${Object.entries(
    values
  )
    .map(([name, value]) => `export ${name}=${shellQuote(value!)}`)
    .join('\n')}\n`;
  const root = join(home, '.mama');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const runtime = join(root, 'runtime');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(runtime, 'secret-'));
  const path = join(staging, 'auth.env');
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, source, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(path, join(root, 'auth.env'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
