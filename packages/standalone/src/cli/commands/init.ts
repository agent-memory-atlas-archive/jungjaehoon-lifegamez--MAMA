import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import type { ConnectorsConfig } from '../../connectors/framework/types.js';
import { parseConfig } from '../../runtime/config.js';
import { findExecutable, launchAgent, startScript } from '../launch-files.js';
import {
  CliInputError,
  createTerminalPrompt,
  nonblankLine,
  requireTTY,
  type PromptAdapter,
} from '../prompt.js';
import { shellQuote, updateSecrets, type SecretName } from '../secrets.js';

export interface InitOptions {
  home?: string;
  prompt?: PromptAdapter;
  cliPath?: string;
  nodePath?: string;
  findExecutable?: (name: string) => string | undefined;
}

const connectorNames = ['slack', 'chatwork', 'trello', 'kagemusha', 'calendar'] as const;
const connectorSecrets: Record<string, SecretName[]> = {
  slack: ['MAMA_SLACK_TOKEN'],
  chatwork: ['MAMA_CHATWORK_TOKEN'],
  trello: ['MAMA_TRELLO_KEY', 'MAMA_TRELLO_TOKEN'],
  kagemusha: [],
  calendar: [],
};

async function yes(prompt: PromptAdapter, label: string): Promise<boolean> {
  const value = (await prompt.text(`${label} [y/N]`)).trim().toLowerCase();
  if (['', 'n', 'no'].includes(value)) return false;
  if (['y', 'yes'].includes(value)) return true;
  throw new CliInputError('Answer yes or no.');
}

async function text(prompt: PromptAdapter, label: string): Promise<string> {
  return nonblankLine(await prompt.text(label)).trim();
}

async function collectConnectors(
  prompt: PromptAdapter,
  secrets: Partial<Record<SecretName, string>>
): Promise<ConnectorsConfig> {
  const selected = (
    await prompt.text(
      `Connectors to enable (${connectorNames.join(', ')}; comma-separated, blank for none)`
    )
  ).trim();
  const names = selected === '' ? [] : [...new Set(selected.split(',').map((name) => name.trim()))];
  if (names.some((name) => !(connectorNames as readonly string[]).includes(name))) {
    throw new CliInputError(`Choose connectors from: ${connectorNames.join(', ')}`);
  }
  const config: ConnectorsConfig = {};
  for (const name of names) {
    for (const tokenName of connectorSecrets[name])
      secrets[tokenName] = nonblankLine(await prompt.secret(tokenName));
    if (name === 'calendar')
      prompt.write(
        'Calendar currently reads the primary calendar only; its source channel id is calendar.'
      );
    const ids = (
      await text(
        prompt,
        `${name} ${name === 'trello' ? 'board' : 'channel'} ids (comma-separated ids only)`
      )
    )
      .split(',')
      .map((id) => id.trim());
    if (ids.some((id) => !id || /\s/.test(id)))
      throw new CliInputError('Enter channel ids separated by commas, without display names.');
    if (name === 'calendar' && (ids.length !== 1 || ids[0] !== 'calendar')) {
      throw new CliInputError(
        'Calendar supports only the source channel id calendar (primary calendar).'
      );
    }
    config[name] = {
      enabled: true,
      pollIntervalMinutes: 5,
      channels: Object.fromEntries(
        ids.map((id) => [id, { role: 'hub', ...(name === 'trello' ? { boardId: id } : {}) }])
      ),
      auth:
        name === 'calendar'
          ? { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' }
          : name === 'kagemusha'
            ? { type: 'none' }
            : { type: 'token', tokenName: connectorSecrets[name].at(-1)! },
    };
  }
  return config;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const prompt = options.prompt ?? createTerminalPrompt();
  requireTTY(prompt);
  const home = options.home ?? homedir();
  const root = join(home, '.mama');
  const configPath = join(root, 'config.yaml');
  if (existsSync(configPath))
    throw new CliInputError('config.yaml already exists; init will not overwrite it.');
  // A partial manual setup must also be reviewed by the owner before replacing files.
  for (const name of ['connectors.json', 'start.sh']) {
    if (existsSync(join(root, name)))
      throw new CliInputError(`${name} already exists; init will not overwrite it.`);
  }
  const backend = await text(prompt, 'Backend (claude|codex)');
  if (backend !== 'claude' && backend !== 'codex')
    throw new CliInputError('Backend must be claude or codex.');
  const model = await text(prompt, 'Model');
  const secrets: Partial<Record<SecretName, string>> = {
    MAMA_TELEGRAM_TOKEN: nonblankLine(await prompt.secret('Telegram bot token')),
  };
  const chatId = await text(prompt, 'Telegram owner chat id');
  const userId = await text(prompt, 'Telegram owner user id');
  if (!/^-?[1-9]\d*$/.test(chatId) || !/^[1-9]\d*$/.test(userId)) {
    throw new CliInputError('Enter numeric Telegram chat and user ids.');
  }
  const connectors = await collectConnectors(prompt, secrets);
  const viewer: Record<string, string> = {};
  if (await yes(prompt, 'Expose the viewer through a tunnel')) {
    const issuer = await text(prompt, 'Access issuer (HTTPS URL)');
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw new CliInputError('Access issuer must be an HTTPS origin.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new CliInputError('Access issuer must be an HTTPS origin.');
    }
    viewer.MAMA_CF_ACCESS_ISSUER = url.origin;
    viewer.MAMA_CF_ACCESS_AUD = await text(prompt, 'Access audience');
    const hostname = await text(prompt, 'Viewer hostname (no scheme or path)');
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(hostname))
      throw new CliInputError('Enter a hostname without scheme or path.');
    viewer.MAMA_VIEWER_HOSTNAMES = hostname;
    const emails = (
      await prompt.text('Viewer owner emails for access monitoring (comma-separated, optional)')
    ).trim();
    if (emails) viewer.MAMA_VIEWER_OWNER_EMAILS = nonblankLine(emails);
  }
  const installLaunchAgent = await yes(
    prompt,
    'Write ~/Library/LaunchAgents/com.mama.server.plist'
  );
  const plistPath = join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist');
  if (installLaunchAgent && existsSync(plistPath))
    throw new CliInputError('com.mama.server.plist already exists; init will not overwrite it.');

  const config = parseConfig(
    {
      version: 1,
      agent: {
        backend,
        model,
        effort: 'medium',
        max_turns: 100,
        timeout: 300_000,
        run_token_budget: 0,
      },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram: {
        enabled: true,
        owner_chat_id: chatId,
        allowed_chats: [chatId],
        owner_user_ids: [userId],
        polling: true,
      },
      wiki: {
        enabled: true,
        vaultPath: join(root, 'workspace'),
        wikiDir: join(root, 'workspace', 'wiki'),
      },
    },
    { home }
  );
  const locate = options.findExecutable ?? findExecutable;
  const backendPath = locate(backend);
  const gwsPath = locate('gws');
  const script = startScript({
    home,
    viewer,
    nodePath: options.nodePath ?? process.execPath,
    cliPath: options.cliPath ?? join(__dirname, '..', 'index.js'),
    executablePaths: [backendPath, gwsPath].filter((path): path is string => path !== undefined),
  });
  secrets.MAMA_AUTH_TOKEN = randomBytes(32).toString('hex');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'workspace', 'wiki'), { recursive: true, mode: 0o700 });
  // Finish all prompts before any write, and publish config last as the setup completion marker.
  updateSecrets(home, secrets);
  writeFileSync(join(root, 'connectors.json'), `${JSON.stringify(connectors, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(join(root, 'start.sh'), script, { flag: 'wx', mode: 0o700 });
  if (installLaunchAgent) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, launchAgent(home), { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(configPath, yaml.dump(config), { flag: 'wx', mode: 0o600 });
  prompt.write('Setup written. Credentials are stored only in auth.env (0600).');
  if (!backendPath)
    prompt.write(`Install ${backend} and add its bin directory to PATH in ~/.mama/start.sh.`);
  prompt.write(
    `If you have not logged in, run: ${backend === 'claude' ? 'claude auth login' : `CODEX_HOME=${shellQuote(join(root, '.codex'))} codex login`}`
  );
  if (connectors.calendar) {
    if (!gwsPath)
      prompt.write('Install gws and add its bin directory to PATH in ~/.mama/start.sh.');
    prompt.write('If Calendar access is not authorised, run: gws auth login');
  }
  if (viewer.MAMA_VIEWER_HOSTNAMES)
    prompt.write(
      'Configure your tunnel to the local viewer and protect its hostname with the Access application above.'
    );
  if (installLaunchAgent)
    prompt.write(
      `After login, start with: launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`
    );
  else prompt.write(`After login, start with: ${shellQuote(join(root, 'start.sh'))}`);
}
