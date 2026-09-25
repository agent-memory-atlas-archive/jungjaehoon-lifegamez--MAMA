import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The archive's local-dashboard / remote-Bearer authentication boundary. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remoteAddress = req.socket?.remoteAddress;
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  );
}

function isTunnelRequest(req: IncomingMessage): boolean {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

function hasCloudflareAccessIdentity(req: IncomingMessage): boolean {
  return Boolean(
    req.headers['cf-access-jwt-assertion'] ||
    req.headers['cf-access-authenticated-user-email'] ||
    req.headers['cf-access-authenticated-user-uuid']
  );
}

function isTrustedCloudflareAccessRequest(req: IncomingMessage): boolean {
  return isLocalRequest(req) && hasCloudflareAccessIdentity(req);
}

function safeTokenEqual(token: string, configured: string): boolean {
  if (token.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(configured));
}

function requestToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  return header.startsWith('Bearer ') ? header.slice(7) : header;
}

/**
 * Direct localhost is the no-token dashboard path. A tunneled localhost request
 * is remote for this decision and therefore needs either a token or Cloudflare
 * Access identity headers, matching the archived server behavior.
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const configured = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
  if (!configured) {
    return isTrustedCloudflareAccessRequest(req) || (isLocalRequest(req) && !isTunnelRequest(req));
  }
  if (isLocalRequest(req) && !isTunnelRequest(req)) return true;
  if (isTrustedCloudflareAccessRequest(req)) return true;
  const token = requestToken(req);
  return token !== null && safeTokenEqual(token, configured);
}

export function requireViewerAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthenticated(req)) return true;
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'WWW-Authenticate': 'Bearer realm="MAMA API"',
  });
  res.end(
    JSON.stringify({
      error: true,
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Provide Authorization: Bearer <token> header.',
    })
  );
  return false;
}
