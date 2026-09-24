import { describe, expect, it } from 'vitest';
import { canonicalChannelKey } from '../../src/connectors/framework/polling-scheduler.js';

describe('canonical channel keys', () => {
  it('maps a provider display name to the configuration key', () => {
    expect(
      canonicalChannelKey(
        { source: 'slack', channel: 'display-room' },
        { slack: { 'channel-key': { role: 'hub', name: 'display-room' } } }
      )
    ).toBe('channel-key');
  });

  it('preserves a Kagemusha origin namespace', () => {
    expect(
      canonicalChannelKey(
        { source: 'kagemusha', channel: 'kagemusha:chatwork:room-key' },
        { kagemusha: { 'kagemusha:chatwork:room-key': { role: 'hub' } } }
      )
    ).toBe('kagemusha:chatwork:room-key');
  });

  it('returns null for an unconfigured channel', () => {
    expect(
      canonicalChannelKey(
        { source: 'slack', channel: 'unknown-room' },
        { slack: { 'channel-key': { role: 'hub' } } }
      )
    ).toBeNull();
  });
});
