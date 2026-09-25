import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticated } from '../../src/api/auth-middleware.js';

function request(remoteAddress: string, headers: Record<string, string>): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('viewer authentication', () => {
  it('allows direct localhost and rejects remote access when no token is configured', () => {
    vi.stubEnv('MAMA_AUTH_TOKEN', '');

    expect(isAuthenticated(request('127.0.0.1', {}))).toBe(true);
    expect(isAuthenticated(request('::1', {}))).toBe(true);
    expect(isAuthenticated(request('192.0.2.10', {}))).toBe(false);
  });

  it('keeps direct localhost open but requires a matching bearer token remotely', () => {
    vi.stubEnv('MAMA_AUTH_TOKEN', 'viewer-token');

    expect(isAuthenticated(request('127.0.0.1', {}))).toBe(true);
    expect(isAuthenticated(request('192.0.2.10', {}))).toBe(false);
    expect(isAuthenticated(request('192.0.2.10', { authorization: 'Bearer viewer-token' }))).toBe(
      true
    );
    expect(isAuthenticated(request('192.0.2.10', { authorization: 'Bearer wrong-token' }))).toBe(
      false
    );
  });

  it('does not treat a tunneled localhost request as local and accepts trusted access identity', () => {
    vi.stubEnv('MAMA_AUTH_TOKEN', 'viewer-token');

    const tunnel = request('127.0.0.1', {
      'cf-ray': 'ray-id',
      'cf-access-authenticated-user-email': 'redacted@example.invalid',
    });
    expect(isAuthenticated(tunnel)).toBe(true);
    expect(isAuthenticated(request('127.0.0.1', { 'cf-ray': 'ray-id' }))).toBe(false);
  });
});
