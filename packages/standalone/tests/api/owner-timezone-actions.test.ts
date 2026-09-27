import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerTimeZoneActionRegistrations } from '../../src/api/owner-timezone-actions.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const homes: string[] = [];
function configFile(contents: string): string {
  const home = mkdtempSync(join(tmpdir(), 'timezone-action-'));
  homes.push(home);
  const path = join(home, 'config.yaml');
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner.timezone.set', () => {
  it('requires a bound owner message and rewrites only the timezone line', async () => {
    const original =
      'version: 1\ntimezone: Asia/Seoul\n# retained exactly\nreports:\n  full_report_hours: [8]\n';
    const path = configFile(original);
    const setting = createTimeZoneSetting('Asia/Seoul');
    const registration = ownerTimeZoneActionRegistrations({
      configPath: path,
      ownerPrincipalId: 'owner',
      setting,
      isOwnerMessageTurn: (ref) => ref === 'owner-ref',
    })[0]!;
    const owner = { principalId: 'owner', agentId: 'agent', scopes: [] };
    expect(() => registration.exec({ timeZone: 'Europe/Paris' }, { access: owner })).toThrow(
      expect.objectContaining({ name: 'denied' })
    );
    expect(() =>
      registration.exec(
        { timeZone: 'Europe/Paris' },
        { access: owner, session: { sourceMessageRef: 'delta-ref' } }
      )
    ).toThrow(expect.objectContaining({ name: 'denied' }));
    expect(() =>
      registration.exec(
        { timeZone: 'Europe/Paris' },
        {
          access: owner,
          session: { sourceMessageRef: 'owner-ref', replaySourceEndMs: 1 },
        }
      )
    ).toThrow(expect.objectContaining({ name: 'denied' }));
    expect(() =>
      registration.exec(
        { timeZone: 'Europe/Paris' },
        {
          access: { ...owner, principalId: 'other' },
          session: { sourceMessageRef: 'owner-ref' },
        }
      )
    ).toThrow(expect.objectContaining({ name: 'denied' }));
    expect(() =>
      registration.exec(
        { timeZone: 'Invalid/Zone' },
        {
          access: owner,
          session: { sourceMessageRef: 'owner-ref' },
        }
      )
    ).toThrow(expect.objectContaining({ name: 'invalid_input' }));
    expect(
      registration.exec(
        { timeZone: 'Europe/Paris' },
        { access: owner, session: { sourceMessageRef: 'owner-ref' } }
      )
    ).toEqual({ timeZone: 'Europe/Paris', previous: 'Asia/Seoul' });
    expect(setting.get()).toBe('Europe/Paris');
    const updated = readFileSync(path, 'utf8');
    expect(updated.replace('timezone: "Europe/Paris"', 'timezone: Asia/Seoul')).toBe(original);
    expect(updated).not.toContain('owner-ref');
  });

  it('appends the setting when it is absent', () => {
    const path = configFile('version: 1\nreports: {}\n');
    const setting = createTimeZoneSetting('UTC');
    const registration = ownerTimeZoneActionRegistrations({
      configPath: path,
      ownerPrincipalId: 'owner',
      setting,
      isOwnerMessageTurn: () => true,
    })[0]!;
    const owner = { principalId: 'owner', agentId: 'agent', scopes: [] };
    expect(
      registration.exec(
        { timeZone: 'Europe/Paris' },
        {
          access: owner,
          session: { sourceMessageRef: 'owner-ref' },
        }
      )
    ).toEqual({ timeZone: 'Europe/Paris', previous: 'UTC' });
    expect(readFileSync(path, 'utf8')).toBe('version: 1\nreports: {}\ntimezone: "Europe/Paris"\n');
  });
});
