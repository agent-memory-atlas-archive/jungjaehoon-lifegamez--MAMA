import type { IncomingMessage } from 'node:http';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticated } from '../../src/api/auth-middleware.js';

function request(remoteAddress: string, headers: Record<string, string>): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

beforeEach(() => {
  vi.stubEnv('MAMA_SERVER_TOKEN', '');
  vi.stubEnv('MAMA_CF_ACCESS_ISSUER', '');
  vi.stubEnv('MAMA_CF_ACCESS_AUD', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('viewer authentication', () => {
  it('allows direct localhost and rejects remote access when no token is configured', async () => {
    vi.stubEnv('MAMA_AUTH_TOKEN', '');

    expect(await isAuthenticated(request('127.0.0.1', {}))).toBe(true);
    expect(await isAuthenticated(request('::1', {}))).toBe(true);
    expect(await isAuthenticated(request('192.0.2.10', {}))).toBe(false);
  });

  it('keeps direct localhost open but requires a matching bearer token remotely', async () => {
    vi.stubEnv('MAMA_AUTH_TOKEN', 'viewer-token');

    expect(await isAuthenticated(request('127.0.0.1', {}))).toBe(true);
    expect(await isAuthenticated(request('192.0.2.10', {}))).toBe(false);
    expect(
      await isAuthenticated(request('192.0.2.10', { authorization: 'Bearer viewer-token' }))
    ).toBe(true);
    expect(
      await isAuthenticated(request('192.0.2.10', { authorization: 'Bearer wrong-token' }))
    ).toBe(false);
  });

  it('does not treat a tunneled localhost request as local and rejects forged access identity', async () => {
    vi.stubEnv('MAMA_AUTH_TOKEN', 'viewer-token');

    const tunnel = request('127.0.0.1', {
      'cf-ray': 'ray-id',
      'cf-access-authenticated-user-email': 'redacted@invalid',
    });
    expect(await isAuthenticated(tunnel)).toBe(false);
    expect(await isAuthenticated(request('127.0.0.1', { 'cf-ray': 'ray-id' }))).toBe(false);
  });
});
