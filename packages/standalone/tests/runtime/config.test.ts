import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, parseConfig, type W1Config } from '../../src/runtime/config.js';

function validConfig(): W1Config {
  return {
    version: 1,
    agent: {
      backend: 'codex',
      model: 'model-under-test',
      effort: 'high',
      max_turns: 30,
      timeout: 30_000,
      run_token_budget: 100,
      codex_home: '/tmp/codex-home',
      codex_cwd: '/tmp/codex-workspace',
      codex_sandbox: 'workspace-write',
      tools: { mcp_config: '/tmp/mcp.json' },
    },
    database: { path: '/tmp/mama-test.db' },
    logging: { level: 'info', file: '/tmp/mama-test.log' },
    telegram: {
      enabled: false,
      token: 'token-placeholder',
      allowed_chats: ['chat-test'],
      owner_user_ids: ['owner-test'],
      polling: false,
    },
  };
}

describe('W1 runtime configuration', () => {
  it('projects the approved YAML fields without retaining retired sections', () => {
    const parsed = parseConfig(validConfig());

    expect(parsed).toEqual(validConfig());
    expect(parsed).not.toHaveProperty('roles');
    expect(parsed).not.toHaveProperty('multi_agent');
  });

  it('reads the owner turn limit and still rejects invalid W1 fields', () => {
    expect(parseConfig({ ...validConfig(), multi_agent: {} })).toMatchObject(validConfig());
    expect(
      parseConfig({
        ...validConfig(),
        agent: { ...validConfig().agent, max_turns: 2 },
      })
    ).toMatchObject({ agent: { max_turns: 2 } });
    expect(() =>
      parseConfig({
        ...validConfig(),
        agent: { ...validConfig().agent, timeout: 0 },
      })
    ).toThrow(/agent\.timeout/);
  });

  it('loads YAML from an explicit path and fails on a missing required section', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-config-'));
    try {
      const path = join(root, 'config.yaml');
      writeFileSync(
        path,
        `version: 1\nagent:\n  backend: codex\n  model: test\n  max_turns: 20\n  timeout: 1000\ndatabase:\n  path: ${join(root, 'db.sqlite')}\nlogging:\n  level: info\n  file: ${join(root, 'mama.log')}\n`
      );
      expect(loadConfig({ path })).toMatchObject({
        version: 1,
        agent: {
          backend: 'codex',
          model: 'test',
          effort: 'medium',
          max_turns: 20,
          run_token_budget: 0,
        },
      });

      writeFileSync(
        path,
        `version: 1\nagent: {}\ndatabase:\n  path: ${join(root, 'db.sqlite')}\nlogging:\n  level: info\n  file: ${join(root, 'mama.log')}\n`
      );
      expect(() => loadConfig({ path })).toThrow(/agent\.backend/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves product-owned home-relative paths before the core boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-config-home-'));
    try {
      const path = join(root, 'config.yaml');
      writeFileSync(
        path,
        'version: 1\nagent:\n  backend: codex\n  model: test\n  max_turns: 20\n  timeout: 1000\ndatabase:\n  path: ~/.data/memory.db\nlogging:\n  level: info\n  file: ~/.data/mama.log\n'
      );
      expect(loadConfig({ path, home: root })).toMatchObject({
        database: { path: join(root, '.data/memory.db') },
        logging: { file: join(root, '.data/mama.log') },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
