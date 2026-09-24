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

  it('maps a Kagemusha source channel id to its configuration key', () => {
    expect(
      canonicalChannelKey(
        { source: 'kagemusha', channel: 'room-key' },
        { kagemusha: { 'room-key': { role: 'hub' } } }
      )
    ).toBe('room-key');
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
