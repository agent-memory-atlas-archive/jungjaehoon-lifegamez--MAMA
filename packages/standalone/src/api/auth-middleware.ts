import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyCfAccessRequest } from './cf-access.js';

/** The archive's local-dashboard / remote-Bearer authentication boundary. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remoteAddress = req.socket?.remoteAddress;
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  );
}

function isTunnelRequest(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some(
    (name) => name === 'cf-connecting-ip' || name === 'cf-ray' || name.startsWith('cf-access-')
  );
}

function safeTokenEqual(token: string, configured: string): boolean {
  const provided = Buffer.from(token);
  const expected = Buffer.from(configured);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function requestToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  return header.startsWith('Bearer ') ? header.slice(7) : header;
}

/**
 * Direct localhost is the no-token dashboard path. A tunneled localhost request
 * is remote for this decision and therefore needs either a token or Cloudflare
 * Access JWT verification.
 */
export async function isAuthenticated(req: IncomingMessage): Promise<boolean> {
  const configured = process.env.MAMA_AUTH_TOKEN;
  if (isLocalRequest(req) && !isTunnelRequest(req)) return true;
  const token = requestToken(req);
  if (configured && token !== null && safeTokenEqual(token, configured)) return true;
  return verifyCfAccessRequest(req.headers);
}

export async function requireViewerAuth(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (await isAuthenticated(req)) return true;
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
