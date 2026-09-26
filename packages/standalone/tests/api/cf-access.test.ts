import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticated, requireViewerAuth } from '../../src/api/auth-middleware.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const publicJwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture',
  alg: 'RS256',
  use: 'sig',
};
// Numeric loopback origins are synthetic; no deployment domains or signing material is persisted.
let issuer: string;
let counter = 10000;
const audience = 'test-audience';
const now = 1_800_000_000;
let fetchMock: ReturnType<typeof vi.fn>;
const request = (headers: IncomingMessage['headers']): IncomingMessage =>
  ({
    socket: { remoteAddress: '127.0.0.1' },
    headers,
  }) as IncomingMessage;
function jwt(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = privateKey
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'fixture', ...header })}.${encode({
    iss: issuer,
    aud: audience,
    exp: now + 120,
    nbf: now - 10,
    iat: now - 10,
    email: 'fixture@invalid',
    ...claims,
  })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
const tunnel = (assertion: string) =>
  request({ 'cf-ray': 'synthetic', 'cf-access-jwt-assertion': assertion });

beforeEach(() => {
  issuer = `https://127.0.0.1:${counter++}`;
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
  vi.stubEnv('MAMA_AUTH_TOKEN', '');
  vi.stubEnv('MAMA_SERVER_TOKEN', '');
  vi.stubEnv('MAMA_CF_ACCESS_ISSUER', issuer);
  vi.stubEnv('MAMA_CF_ACCESS_AUD', audience);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('signed viewer Access authentication', () => {
  it('does not accept the retired token alias or throw on different UTF-8 byte lengths', async () => {
    vi.stubEnv('MAMA_SERVER_TOKEN', 'synthetic');
    expect(
      await isAuthenticated(request({ 'cf-ray': 'test', authorization: 'Bearer synthetic' }))
    ).toBe(false);
    vi.stubEnv('MAMA_AUTH_TOKEN', 'ab');
    expect(await isAuthenticated(request({ 'cf-ray': 'test', authorization: 'Bearer éé' }))).toBe(
      false
    );
  });
  it('accepts RS256, array audience and clock skew; caches issuer keys for ten minutes', async () => {
    expect(await isAuthenticated(tunnel(jwt()))).toBe(true);
    expect(
      await isAuthenticated(
        tunnel(jwt({ aud: ['other', audience], exp: now - 59, nbf: now + 59, iat: now + 59 }))
      )
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${issuer}/cdn-cgi/access/certs`,
      expect.objectContaining({ redirect: 'error' })
    );
    vi.setSystemTime((now + 601) * 1000);
    expect(await isAuthenticated(tunnel(jwt({ exp: now + 1000 })))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { exp: now - 60 },
    { exp: null },
    { exp: 'later' },
    { nbf: now + 61 },
    { iat: now + 61 },
    { nbf: 'later' },
    { iat: null },
    { iss: 'wrong' },
    { aud: 'wrong' },
    { aud: [] },
    { email: undefined },
    { email: 'invalid' },
  ])('rejects invalid claims %#', async (claims) => {
    expect(await isAuthenticated(tunnel(jwt(claims)))).toBe(false);
  });

  it('rejects unsigned, wrong-algorithm, wrong-key, missing-kid and malformed assertions', async () => {
    for (const token of [
      jwt({}, { alg: 'none' }),
      jwt({}, { alg: 'HS256' }),
      jwt({}, { kid: 'missing' }),
      jwt({}, {}, wrongKey),
      'invalid',
      'a.b.c',
    ]) {
      expect(await isAuthenticated(tunnel(token))).toBe(false);
    }
    expect(await isAuthenticated(request({ 'cf-access-jwt-assertion': [jwt(), jwt()] }))).toBe(
      false
    );
  });

  it.each(['MAMA_CF_ACCESS_ISSUER', 'MAMA_CF_ACCESS_AUD'])(
    'fails closed with %s unset, while a matching token works',
    async (name) => {
      const assertion = jwt();
      vi.stubEnv(name, '');
      expect(await isAuthenticated(tunnel(assertion))).toBe(false);
      const token = randomBytes(24).toString('hex');
      vi.stubEnv('MAMA_AUTH_TOKEN', token);
      expect(
        await isAuthenticated(request({ 'cf-ray': 'synthetic', authorization: `Bearer ${token}` }))
      ).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('rejects every tunnel-header shortcut and keeps direct loopback working', async () => {
    for (const name of [
      'cf-ray',
      'cf-connecting-ip',
      'cf-access-authenticated-user-email',
      'cf-access-authenticated-user-uuid',
      'cf-access-custom',
    ]) {
      expect(await isAuthenticated(request({ [name]: 'synthetic' }))).toBe(false);
      expect(await isAuthenticated(request({ [name]: '' }))).toBe(false);
    }
    expect(await isAuthenticated(request({}))).toBe(true);
  });

  it('fails closed on key retrieval errors and does not print request or error details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('synthetic private detail'));
    expect(await isAuthenticated(tunnel(jwt()))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('awaits authentication before allowing a response and returns 401 on failure', async () => {
    const response = { writeHead: vi.fn(), end: vi.fn() };
    expect(await requireViewerAuth(tunnel(jwt()), response as unknown as ServerResponse)).toBe(
      true
    );
    expect(response.end).not.toHaveBeenCalled();
    expect(await requireViewerAuth(tunnel('bad'), response as unknown as ServerResponse)).toBe(
      false
    );
    expect(response.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it('logs disabled verification only once without configuration values', async () => {
    vi.stubEnv('MAMA_CF_ACCESS_AUD', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { logCfAccessConfiguration } = await import('../../src/api/cf-access.js');
    logCfAccessConfiguration();
    logCfAccessConfiguration();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('Access verification is off');
    expect(String(warn.mock.calls[0]).includes(issuer)).toBe(false);
  });
});
