import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, parseConfig, type W1Config } from '../../src/runtime/config.js';

let testHome: string;
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'report-config-'));
  vi.stubEnv('HOME', testHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(testHome, { recursive: true, force: true });
});

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
    jev: {
      keyFile: '/tmp/jev-key',
      vocabFile: '/tmp/vocab.json',
    },
    reports: { full_report_hours: [8, 13, 18], reminder_start_hour: 9, reminder_end_hour: 21 },
  };
}

describe('W1 runtime configuration', () => {
  it('defaults report hours and accepts custom KST hours through YAML without ignoring them', () => {
    const { reports, ...base } = validConfig();
    expect(parseConfig(base).reports).toEqual(reports);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testHome, 'config.yaml');
    writeFileSync(
      path,
      JSON.stringify({
        ...base,
        reports: { full_report_hours: [0, 23], reminder_start_hour: 1, reminder_end_hour: 22 },
      })
    );
    expect(loadConfig({ path }).reports).toEqual({
      full_report_hours: [0, 23],
      reminder_start_hour: 1,
      reminder_end_hour: 22,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(parseConfig({ ...base, reports: { full_report_hours: [] } }).reports).toEqual({
      ...reports,
      full_report_hours: [],
    });
  });

  it.each([
    null,
    { full_report_hours: '8,13,18' },
    { full_report_hours: [24] },
    { full_report_hours: [-1] },
    { full_report_hours: [8.5] },
    { full_report_hours: ['8'] },
    { full_report_hours: null },
    { reminder_start_hour: -1 },
    { reminder_end_hour: 24 },
    { reminder_start_hour: 1.5 },
    { reminder_end_hour: null },
    { reminder_start_hour: 22, reminder_end_hour: 9 },
  ])('rejects invalid report hours: %j', (reports) => {
    expect(() => parseConfig({ ...validConfig(), reports })).toThrow(/reports/);
  });

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

  it('polls Telegram when telegram.polling is absent, as the owner config has it', () => {
    const base = validConfig();
    const { polling: _polling, ...telegramWithoutPolling } = base.telegram;
    const parsed = parseConfig({ ...base, telegram: telegramWithoutPolling });
    expect(parsed.telegram.polling).toBe(true);
    expect(
      parseConfig({ ...base, telegram: { ...telegramWithoutPolling, polling: false } }).telegram
        .polling
    ).toBe(false);
  });

  it('requires an allowlisted owner chat when Telegram is enabled', () => {
    const base = validConfig();
    expect(() => parseConfig({ ...base, telegram: { ...base.telegram, enabled: true } })).toThrow(
      /telegram\.owner_chat_id is required/
    );
    expect(() =>
      parseConfig({
        ...base,
        telegram: { ...base.telegram, enabled: true, owner_chat_id: 'chat-other' },
      })
    ).toThrow(/telegram\.owner_chat_id must be listed in telegram\.allowed_chats/);
    expect(
      parseConfig({
        ...base,
        telegram: { ...base.telegram, enabled: true, owner_chat_id: 'chat-test' },
      }).telegram.owner_chat_id
    ).toBe('chat-test');
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

  it('supplies the owner-configured Jev key and vocabulary paths without reading either file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-config-jev-'));
    try {
      const parsed = parseConfig({ ...validConfig(), jev: undefined }, { home: root });
      expect(parsed.jev).toEqual({
        keyFile: join(root, '.mama/jev-key'),
        vocabFile: join(root, '.mama/backfill/vocab.json'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
