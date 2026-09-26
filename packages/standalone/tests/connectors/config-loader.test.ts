import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConnectorConfig } from '../../src/connectors/config-loader.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'connector-config-'));
  roots.push(root);
  const path = join(root, 'connectors.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

const valid = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'channel-key': { role: 'hub', name: 'display-name', boardId: 'board-key' } },
  auth: { type: 'token', tokenName: 'TEST_CONNECTOR_TOKEN' },
};

describe('connector config loader', () => {
  it.each([false, true])(
    'loads calendar CLI auth without ignoring or enabling it (%s)',
    (enabled) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calendar = {
        enabled,
        pollIntervalMinutes: 5,
        channels: { calendar: { role: 'reference' } },
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      };
      const result = loadConnectorConfig(writeConfig({ calendar }));
      expect(result).toEqual({
        ok: true,
        config: { calendar },
        enabledNames: enabled ? ['calendar'] : [],
      });
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it('normalizes connector names and returns only enabled names', () => {
    const result = loadConnectorConfig(
      writeConfig({ Slack: valid, Trello: { ...valid, enabled: false } })
    );
    expect(result).toMatchObject({ ok: true, enabledNames: ['slack'] });
    expect(result.ok && result.config.slack?.channels['channel-key']?.name).toBe('display-name');
  });

  it('treats a missing file as an empty successful configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-config-missing-'));
    roots.push(root);
    const result = loadConnectorConfig(join(root, 'missing.json'));
    expect(result).toMatchObject({ ok: true, config: {}, enabledNames: [] });
  });

  it('fails closed without echoing auth values', () => {
    const path = writeConfig({ trello: { ...valid, auth: { type: 'token', tokenName: 7 } } });
    const result = loadConnectorConfig(path);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
});
