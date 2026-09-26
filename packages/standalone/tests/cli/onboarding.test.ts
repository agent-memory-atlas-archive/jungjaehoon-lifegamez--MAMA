import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../../src/cli/commands/init.js';
import { runSecret } from '../../src/cli/commands/secret.js';
import type { PromptAdapter } from '../../src/cli/prompt.js';
import { loadConfig } from '../../src/runtime/config.js';
import { loadConnectorConfig } from '../../src/connectors/config-loader.js';

let home: string;
let root: string;
const fixtureSecrets = {
  MAMA_TELEGRAM_TOKEN: 'fixture-telegram',
  MAMA_SLACK_TOKEN: 'fixture-slack',
  MAMA_CHATWORK_TOKEN: 'fixture-chatwork',
  MAMA_TRELLO_KEY: 'fixture-key',
  MAMA_TRELLO_TOKEN: 'fixture-trello',
};

function prompt(answers: string[], hidden: string[], tty = [true, true]) {
  const output: string[] = [];
  const adapter: PromptAdapter = {
    stdinIsTTY: tty[0],
    stdoutIsTTY: tty[1],
    text: async () => {
      if (!answers.length) throw new Error('Unexpected visible prompt');
      return answers.shift()!;
    },
    secret: async () => {
      if (!hidden.length) throw new Error('Unexpected secret prompt');
      return hidden.shift()!;
    },
    write: (line) => {
      output.push(line);
    },
  };
  return { adapter, output, answers, hidden };
}

function minimal(backend = 'codex', launch = 'n') {
  return [backend, 'fixture-model', '100', '101', '', 'n', launch];
}

function options(adapter: PromptAdapter) {
  return {
    prompt: adapter,
    home,
    cliPath: join(home, 'package', 'cli.js'),
    nodePath: process.execPath,
    findExecutable: (name: string) => join(home, 'bin', name),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mama-init-'));
  root = join(home, '.mama');
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'dev.db'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('owner-only onboarding', () => {
  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])('refuses init and secret set without both TTYs %j', async (...tty) => {
    const p = prompt([], [], tty);
    await expect(runInit(options(p.adapter))).rejects.toThrow(/TTY/);
    await expect(
      runSecret(['set', 'MAMA_TELEGRAM_TOKEN'], { home, prompt: p.adapter })
    ).rejects.toThrow(/TTY/);
    expect(existsSync(root)).toBe(false);
  });

  it('refuses existing config before prompting or changing auth.env', async () => {
    mkdirSync(root);
    writeFileSync(join(root, 'config.yaml'), 'existing');
    writeFileSync(join(root, 'auth.env'), '# untouched\n');
    const p = prompt([], []);
    await expect(runInit(options(p.adapter))).rejects.toThrow(/config.yaml.*exists/);
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).toBe('existing');
    expect(readFileSync(join(root, 'auth.env'), 'utf8')).toBe('# untouched\n');
  });

  it.each(['claude', 'codex'])(
    'writes a loadable secret-free config and executable start script for %s',
    async (backend) => {
      const p = prompt(minimal(backend), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
      await runInit(options(p.adapter));
      const config = loadConfig({ home });
      expect(config.agent.backend).toBe(backend);
      expect(config.agent.model).toBe('fixture-model');
      expect(config.telegram).toMatchObject({
        enabled: true,
        owner_chat_id: '100',
        owner_user_ids: ['101'],
        allowed_chats: ['100'],
        polling: true,
      });
      expect(config.telegram).not.toHaveProperty('token');
      expect(loadConnectorConfig(join(root, 'connectors.json'))).toMatchObject({
        ok: true,
        enabledNames: [],
      });
      for (const file of ['auth.env', 'config.yaml', 'connectors.json']) {
        expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      }
      expect(statSync(join(root, 'start.sh')).mode & 0o777).toBe(0o700);
      expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist'))).toBe(
        false
      );
      expect(p.output.join('\n')).toContain(
        backend === 'claude' ? 'claude auth login' : 'codex login'
      );
      expect(p.answers).toEqual([]);
      expect(p.hidden).toEqual([]);
    }
  );

  it('wires every selected connector, tunnel environment and opt-in launchd without leaking credentials', async () => {
    const p = prompt(
      [
        'claude',
        'fixture-model',
        '100',
        '101',
        'slack,chatwork,trello,kagemusha,calendar',
        'channel-a,channel-b',
        'room-a',
        'board-a',
        'source-a',
        'calendar',
        'y',
        'https://access.example.test',
        'fixture-audience',
        'viewer.example.test',
        '',
        'y',
      ],
      Object.values(fixtureSecrets)
    );
    await runInit(options(p.adapter));
    const loaded = loadConnectorConfig(join(root, 'connectors.json'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Generated connector config was rejected');
    expect(loaded.config.slack.auth.tokenName).toBe('MAMA_SLACK_TOKEN');
    expect(loaded.config.chatwork.auth.tokenName).toBe('MAMA_CHATWORK_TOKEN');
    expect(loaded.config.trello.auth.tokenName).toBe('MAMA_TRELLO_TOKEN');
    expect(loaded.config.trello.channels['board-a']).toEqual({ role: 'hub', boardId: 'board-a' });
    expect(Object.keys(loaded.config.slack.channels)).toEqual(['channel-a', 'channel-b']);
    expect(loaded.config.calendar.auth.cli).toBe('gws');
    const auth = execFileSync('/bin/sh', ['-c', '. "$1"; env', 'sh', join(root, 'auth.env')], {
      env: { HOME: home },
      encoding: 'utf8',
    });
    for (const [name, value] of Object.entries(fixtureSecrets)) {
      expect(auth.includes(`${name}=${value}\n`)).toBe(true);
    }
    const generatedToken = auth
      .split('\n')
      .find((line) => line.startsWith('MAMA_AUTH_TOKEN='))!
      .slice('MAMA_AUTH_TOKEN='.length);
    expect(/^[a-f0-9]{64}$/.test(generatedToken)).toBe(true);
    const publicFiles = ['config.yaml', 'connectors.json', 'start.sh'].map((file) =>
      readFileSync(join(root, file), 'utf8')
    );
    const plist = join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist');
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    for (const text of [...publicFiles, readFileSync(plist, 'utf8'), ...p.output]) {
      for (const value of [...Object.values(fixtureSecrets), generatedToken])
        expect(text.includes(value)).toBe(false);
    }
    expect(p.output.join('\n')).toContain('launchctl bootstrap');
    expect(p.output.join('\n')).toContain('gws auth login');
    expect(p.answers).toEqual([]);
    expect(p.hidden).toEqual([]);
    // Execute the generated script with a harmless daemon substitute; no real CLI or network.
    mkdirSync(join(home, 'package'));
    writeFileSync(
      join(home, 'package', 'cli.js'),
      `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.HOME + '/launch-result.json', JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH,
        issuer: process.env.MAMA_CF_ACCESS_ISSUER, audience: process.env.MAMA_CF_ACCESS_AUD,
        host: process.env.MAMA_VIEWER_HOSTNAMES,
        tokenLoaded: !!process.env.MAMA_TELEGRAM_TOKEN, authLoaded: !!process.env.MAMA_AUTH_TOKEN
      }));
    `
    );
    execFileSync(join(root, 'start.sh'), [], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
    const result = JSON.parse(readFileSync(join(home, 'launch-result.json'), 'utf8'));
    expect(result).toMatchObject({
      argv: ['daemon'],
      cwd: realpathSync(root),
      issuer: 'https://access.example.test',
      audience: 'fixture-audience',
      host: 'viewer.example.test',
      tokenLoaded: true,
      authLoaded: true,
    });
    expect(result.path.split(':')).toContain(join(home, 'bin'));
    expect(readdirSync(join(root, 'runtime'))).toEqual([]);
  });

  it('does not overwrite an existing launch agent', async () => {
    const dir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'com.mama.server.plist'), 'existing');
    const p = prompt(minimal('codex', 'y'), ['fixture-telegram']);
    await expect(runInit(options(p.adapter))).rejects.toThrow(/plist.*exists/);
    expect(readFileSync(join(dir, 'com.mama.server.plist'), 'utf8')).toBe('existing');
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('leaves no partial setup after a cancelled hidden prompt', async () => {
    const p = prompt(['codex', 'fixture-model'], []);
    p.adapter.secret = async () => {
      throw new Error('Input cancelled');
    };
    await expect(runInit(options(p.adapter))).rejects.toThrow(/cancelled/);
    expect(existsSync(root)).toBe(false);
  });
});

describe('secret rotation', () => {
  it('replaces only the chosen name atomically, preserves literal shell characters and lists names only without a TTY', async () => {
    mkdirSync(root);
    writeFileSync(
      join(root, 'auth.env'),
      "# retained\nexport MAMA_SLACK_TOKEN='fixture-old'\nexport MAMA_AUTH_TOKEN='fixture-other'\n",
      { mode: 0o644 }
    );
    const before = statSync(join(root, 'auth.env')).ino;
    const secret = 'fixture\'$() `literal` \\"#value';
    const p = prompt([], [secret]);
    await runSecret(['set', 'MAMA_SLACK_TOKEN'], { home, prompt: p.adapter });
    expect(statSync(join(root, 'auth.env')).ino).not.toBe(before);
    expect(statSync(join(root, 'auth.env')).mode & 0o777).toBe(0o600);
    const value = execFileSync(
      '/bin/sh',
      ['-c', '. "$1"; printf %s "$MAMA_SLACK_TOKEN"', 'sh', join(root, 'auth.env')],
      { encoding: 'utf8', env: { HOME: home } }
    );
    expect(value === secret).toBe(true);
    expect(
      readFileSync(join(root, 'auth.env'), 'utf8').includes("MAMA_AUTH_TOKEN='fixture-other'")
    ).toBe(true);
    const listing = prompt([], [], [false, false]);
    await runSecret(['list'], { home, prompt: listing.adapter });
    expect(listing.output).toEqual(['MAMA_AUTH_TOKEN', 'MAMA_SLACK_TOKEN']);
    expect(readdirSync(join(root, 'runtime'))).toEqual([]);
  });

  it.each(['MAMA_CF_ACCESS_ISSUER', 'PATH', 'NOT_ALLOWED', 'MAMA_SLACK_TOKEN=bad'])(
    'rejects names outside the secret allowlist %#',
    async (name) => {
      const p = prompt([], []);
      await expect(runSecret(['set', name], { home, prompt: p.adapter })).rejects.toThrow(
        /Allowed secret names/
      );
      expect(existsSync(root)).toBe(false);
    }
  );

  it.each(['', 'fixture\nextra', 'fixture\0extra'])(
    'rejects blank or multiline values without changing the file %#',
    async (value) => {
      mkdirSync(root);
      writeFileSync(join(root, 'auth.env'), '# retained\n');
      const p = prompt([], [value]);
      await expect(
        runSecret(['set', 'MAMA_TELEGRAM_TOKEN'], { home, prompt: p.adapter })
      ).rejects.toThrow(/nonblank.*single line/);
      expect(readFileSync(join(root, 'auth.env'), 'utf8')).toBe('# retained\n');
    }
  );
});
