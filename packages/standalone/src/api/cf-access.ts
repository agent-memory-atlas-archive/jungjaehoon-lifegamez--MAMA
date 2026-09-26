import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const CACHE_MS = 10 * 60 * 1000;
const SKEW_SECONDS = 60;
const cache = new Map<string, { expires: number; keys: Record<string, unknown>[] }>();
let loggedDisabled = false;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function config(): { issuer: string; audience: string } | null {
  const issuer = process.env.MAMA_CF_ACCESS_ISSUER?.trim().replace(/\/$/, '');
  const audience = process.env.MAMA_CF_ACCESS_AUD?.trim();
  if (!issuer || !audience) return null;
  try {
    const url = new URL(issuer);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return null;
  } catch {
    return null;
  }
  return { issuer, audience };
}

/** Called when the viewer is constructed, so the daemon reports this once at startup. */
export function logCfAccessConfiguration(): void {
  if (!config() && !loggedDisabled) {
    loggedDisabled = true;
    console.warn(
      '[auth] Access verification is off; tunnelled requests require the viewer token. Configure MAMA_CF_ACCESS_ISSUER and MAMA_CF_ACCESS_AUD.'
    );
  }
}

async function jwks(issuer: string): Promise<Record<string, unknown>[]> {
  const existing = cache.get(issuer);
  if (existing && existing.expires > Date.now()) return existing.keys;
  // Never follow a redirect away from the configured issuer. Bound auth request latency.
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('Access key retrieval failed');
  const payload: unknown = await response.json();
  if (!record(payload) || !Array.isArray(payload.keys)) throw new Error('Invalid Access keys');
  const keys = payload.keys.filter(record);
  cache.set(issuer, { expires: Date.now() + CACHE_MS, keys });
  return keys;
}

/** Verify the signed assertion, never the unsigned identity headers. No credentials are logged. */
export async function verifyCfAccessRequest(headers: IncomingHttpHeaders): Promise<boolean> {
  const settings = config();
  const token = headers['cf-access-jwt-assertion'];
  if (!settings || typeof token !== 'string') return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (
      !record(header) ||
      !record(claims) ||
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string'
    )
      return false;
    if (claims.iss !== settings.issuer) return false;
    if (
      claims.aud !== settings.audience &&
      !(Array.isArray(claims.aud) && claims.aud.includes(settings.audience))
    )
      return false;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now - SKEW_SECONDS
    )
      return false;
    for (const time of [claims.nbf, claims.iat]) {
      if (
        time !== undefined &&
        (typeof time !== 'number' || !Number.isFinite(time) || time > now + SKEW_SECONDS)
      )
        return false;
    }
    if (typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(claims.email)) return false;
    const key = (await jwks(settings.issuer)).find(
      (item) =>
        item.kid === header.kid &&
        item.kty === 'RSA' &&
        (item.alg === undefined || item.alg === 'RS256') &&
        (item.use === undefined || item.use === 'sig')
    );
    if (!key) return false;
    return verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: key as JsonWebKey, format: 'jwk' }),
      Buffer.from(parts[2]!, 'base64url')
    );
  } catch {
    // Fetch errors may contain deployment details; authentication fails closed without logging them.
    return false;
  }
}
