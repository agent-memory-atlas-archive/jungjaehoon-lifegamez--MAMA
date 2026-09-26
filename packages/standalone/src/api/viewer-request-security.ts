import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { redactTraceText } from '@jungjaehoon/mama-core/runtime/trace-summary';
import { isTunnelRequest, type ViewerIdentity } from './auth-middleware.js';

function hostname(authority: string): string | null {
  if (!authority || authority.length > 260 || /[\s\\/@?#,%]/.test(authority)) return null;
  const match = authority.startsWith('[')
    ? authority.match(/^(\[[0-9a-fA-F:]+\])(?::([0-9]+))?$/)
    : authority.match(/^([a-zA-Z0-9.-]+)(?::([0-9]+))?$/);
  if (!match) return null;
  const port = match[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  const host = match[1]!;
  if (host.startsWith('[')) {
    if (isIP(host.slice(1, -1)) !== 6) return null;
    return new URL(`http://${host}`).hostname;
  }
  const canonical = host.toLowerCase().replace(/\.$/, '');
  if (
    canonical.length > 253 ||
    canonical.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  // Do not let URL's legacy numeric IPv4 normalization turn attacker input into loopback.
  return canonical;
}

/** DNS rebinding can reach the loopback socket: Host must be approved before local auth. */
export function isAllowedViewerHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  if (
    req.rawHeaders?.filter(
      (_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'host'
    ).length > 1
  )
    return false;
  const requested = hostname(host);
  if (requested === null) return false;
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const value of (process.env.MAMA_VIEWER_HOSTNAMES ?? '').split(',')) {
    const name = hostname(value.trim());
    if (name !== null) allowed.add(name);
  }
  return allowed.has(requested);
}

function configuredValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        value &&
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL|AUTH_KEY|AUTHORIZATION|ISSUER|HOSTNAME|HOSTNAMES|API_HOST)$/i.test(
          name
        )
    )
    .flatMap(([, value]) =>
      value!
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
    .sort((left, right) => right.length - left.length);
}

function auditField(value: string, limit = 256): string {
  let safe = value;
  for (const configured of configuredValues()) {
    safe = safe.split(configured).join('[redacted]');
    safe = safe.split(encodeURIComponent(configured)).join('[redacted]');
  }
  return Array.from(redactTraceText(safe), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? '_' : character;
  })
    .join('')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, limit);
}

function auditPath(req: IncomingMessage): string {
  const target = req.url ?? '/';
  try {
    const path = new URL(target, 'http://localhost').pathname;
    // A path may contain an encoded credential; decode only for redaction, never routing.
    return auditField(decodeURIComponent(path));
  } catch {
    return '[invalid-path]';
  }
}

export function viewerRequestAudit(
  req: IncomingMessage,
  res: ServerResponse
): {
  identity: ViewerIdentity | null;
  log: () => void;
} {
  let logged = false;
  const audit = {
    identity: null as ViewerIdentity | null,
    log() {
      if (logged || (!isTunnelRequest(req) && res.statusCode !== 401)) return;
      logged = true;
      const ray = req.headers['cf-ray'];
      console.info(
        `[viewer] ${JSON.stringify({
          method: [
            'GET',
            'HEAD',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
            'OPTIONS',
            'TRACE',
            'CONNECT',
          ].includes(req.method ?? '')
            ? req.method
            : 'UNKNOWN',
          path: auditPath(req),
          status: res.statusCode,
          cfRay:
            typeof ray !== 'string'
              ? null
              : /^[a-fA-F0-9]{16,32}(?:-[A-Z]{3,8})?$/.test(ray)
                ? auditField(ray)
                : '[invalid]',
          identity: audit.identity ?? 'anonymous',
        })}`
      );
    },
  };
  res.once('finish', audit.log);
  res.once('close', audit.log);
  return audit;
}

/** Error messages and stacks can contain secrets or deployment URLs; emit diagnostic metadata. */
export function logViewerInternalError(error: unknown): void {
  const name =
    error instanceof Error &&
    ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'URIError'].includes(error.name)
      ? error.name
      : 'Error';
  const rawCode =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code =
    typeof rawCode === 'string' &&
    /^(EACCES|ENOENT|EIO|EMFILE|ENFILE|EPERM|EISDIR|SQLITE_ERROR|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_CANTOPEN|SQLITE_FULL)$/.test(
      rawCode
    )
      ? rawCode
      : 'UNEXPECTED';
  const message = safeErrorDetail(error instanceof Error ? error.message : String(error), 800);
  const stack =
    error instanceof Error
      ? redactTraceText(error.stack ?? '')
          .split('\n')
          .slice(1, 6)
          .map((line) => safeErrorDetail(line, 240))
      : [];
  const cause =
    error instanceof Error && error.cause !== undefined
      ? safeErrorDetail(
          error.cause instanceof Error ? error.cause.message : String(error.cause),
          400
        )
      : undefined;
  console.error(
    `[viewer] ${JSON.stringify({ event: 'internal_error', name, code, message, stack, cause })}`
  );
}

function safeErrorDetail(value: string, limit: number): string {
  return auditField(value, 4000)
    .replace(/https?:\/\/[^\s)'"]+/gi, '[url]')
    .replace(/(?:file:\/\/)?(?:\/[^\s/:'"()]+){2,}/g, '[path]')
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*(?::[0-9]+)?\b/gi, '[host]')
    .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?\b/g, '[address]')
    .slice(0, limit);
}
