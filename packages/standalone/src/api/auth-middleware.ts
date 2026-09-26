import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifiedCfAccessEmail } from './cf-access.js';

/** The archive's local-dashboard / remote-Bearer authentication boundary. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remoteAddress = req.socket?.remoteAddress;
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  );
}

export function isTunnelRequest(req: IncomingMessage): boolean {
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
export type ViewerIdentity = 'local' | 'token' | `access:${string}`;

/** Observation only: owner email membership does not change the authentication policy. */
export interface ViewerAuthObservation {
  accessVerified: boolean;
  unknownIdentity: boolean;
}

export async function authenticateViewerRequest(
  req: IncomingMessage,
  observation?: ViewerAuthObservation
): Promise<ViewerIdentity | null> {
  const configured = process.env.MAMA_AUTH_TOKEN;
  if (isLocalRequest(req) && !isTunnelRequest(req)) return 'local';
  const token = requestToken(req);
  const validToken = configured && token !== null && safeTokenEqual(token, configured);
  if (validToken && !observation) return 'token';
  const email = await verifiedCfAccessEmail(req.headers);
  if (observation) {
    observation.accessVerified = email !== null;
    const owners = process.env.MAMA_VIEWER_OWNER_EMAILS;
    observation.unknownIdentity =
      email !== null &&
      owners !== undefined &&
      !owners
        .split(',')
        .map((owner) => owner.trim().toLowerCase())
        .includes(email.toLowerCase());
  }
  if (validToken) return 'token';
  return email === null
    ? null
    : `access:${createHash('sha256').update(email).digest('hex').slice(0, 12)}`;
}

export async function isAuthenticated(req: IncomingMessage): Promise<boolean> {
  return (await authenticateViewerRequest(req)) !== null;
}

export async function requireViewerAuth(
  req: IncomingMessage,
  res: ServerResponse,
  identity?: ViewerIdentity | null
): Promise<boolean> {
  if ((identity === undefined ? await authenticateViewerRequest(req) : identity) !== null)
    return true;
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
