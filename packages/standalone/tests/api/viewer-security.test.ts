import { EventEmitter } from 'node:events';
import { randomBytes, generateKeyPairSync, sign, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createViewerServer, type ViewerServerOptions } from '../../src/api/viewer-server.js';

const transport = vi.hoisted(() => ({
  handler: undefined as undefined | ((req: IncomingMessage, res: ServerResponse) => void),
}));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  createServer: (handler: typeof transport.handler) => {
    transport.handler = handler;
    return Object.assign(new EventEmitter(), {
      listen: (_options: unknown, callback: () => void) => callback(),
      address: () => ({ port: 3847 }),
      close: (callback: () => void) => callback(),
    });
  },
}));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, readFileSync: vi.fn(real.readFileSync), readSync: vi.fn(real.readSync) };
});
const roots: string[] = [];
let audit: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const dispatch = vi.fn();

beforeEach(() => {
  vi.stubEnv('MAMA_AUTH_TOKEN', '');
  vi.stubEnv('MAMA_CF_ACCESS_ISSUER', '');
  vi.stubEnv('MAMA_CF_ACCESS_AUD', '');
  vi.stubEnv('MAMA_VIEWER_HOSTNAMES', '');
  audit = vi.spyOn(console, 'info').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dispatch.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function serve(options: Partial<ViewerServerOptions> = {}) {
  const server = createViewerServer({ dispatch, ownerAccess: {} as never, ...options });
  await server.start();
}
function request(
  path = '/api/runtime/status',
  headers: IncomingMessage['headers'] = {},
  remoteAddress = '127.0.0.1',
  method = 'GET',
  rawHeaders?: string[]
) {
  return new Promise<{ status: number; body: string }>((resolve) => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
      setHeader: () => {},
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
      },
      end(body = '') {
        this.emit('finish');
        resolve({ status: this.statusCode, body });
      },
    });
    transport.handler!(
      {
        url: path,
        method,
        headers: { host: 'localhost', ...headers },
        rawHeaders:
          rawHeaders ??
          Object.entries({ host: 'localhost', ...headers }).flatMap(([name, value]) => [
            name,
            String(value),
          ]),
        socket: { remoteAddress },
      } as IncomingMessage,
      response as unknown as ServerResponse
    );
  });
}
function auditRow() {
  expect(audit).toHaveBeenCalledTimes(1);
  return JSON.parse(String(audit.mock.calls[0]![0]).replace(/^\[viewer\] /, ''));
}

describe('viewer request security', () => {
  it.each([
    'attacker.invalid',
    'localhost.attacker.invalid',
    'localhost@attacker.invalid',
    'localhost/anything',
    'localhost\\anything',
    'localhost:bad',
    'localhost:65536',
    'localhost:',
    'localhost:0',
    '[::1',
    '::1',
    '[::1]:bad',
    '[::1]:65536',
    '127.1',
    '2130706433',
    '0x7f000001',
    'localhost,attacker.invalid',
    ' localhost',
    '',
    ['localhost', 'attacker.invalid'],
  ])('rejects unapproved or malformed authority before auth %#', async (host) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await serve({
      getRuntimeStatus: () => {
        throw new Error('must not run');
      },
    });
    const response = await request('/api/runtime/status', {
      host: host as string,
      'cf-access-jwt-assertion': 'synthetic',
    });
    expect(response.status).toBe(421);
    expect(fetcher).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects duplicated Host headers even when Node exposes only the first', async () => {
    await serve();
    expect(
      (
        await request('/health', {}, '127.0.0.1', 'GET', [
          'Host',
          'localhost',
          'Host',
          'attacker.invalid',
        ])
      ).status
    ).toBe(421);
  });
  it.each([
    'localhost',
    'LOCALHOST:3847',
    'localhost.',
    '127.0.0.1:3847',
    '[::1]',
    '[0:0:0:0:0:0:0:1]:3847',
  ])('allows loopback authorities %#', async (host) => {
    await serve();
    expect((await request('/health', { host })).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
  it('accepts only exact comma-separated configured authorities', async () => {
    vi.stubEnv('MAMA_VIEWER_HOSTNAMES', ' viewer.invalid, second.invalid ');
    await serve();
    expect((await request('/health', { host: 'VIEWER.invalid:443' })).status).toBe(200);
    expect((await request('/health', { host: 'second.invalid' })).status).toBe(200);
    expect((await request('/health', { host: 'sub.viewer.invalid' })).status).toBe(421);
  });
  it('checks Host on static, health and OPTIONS routes as well', async () => {
    await serve();
    for (const [path, method] of [
      ['/', 'GET'],
      ['/health', 'GET'],
      ['/api/runtime/status', 'OPTIONS'],
    ]) {
      expect((await request(path, { host: 'attacker.invalid' }, '127.0.0.1', method)).status).toBe(
        421
      );
    }
  });
  it('logs one token audit record without queries or token values', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    await serve({ getRuntimeStatus: () => ({ running: true }) as never });
    const response = await request(`/api/runtime/status?secret=${token}`, {
      'cf-ray': '0123456789abcdef-TST',
      authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(200);
    expect(auditRow()).toMatchObject({
      method: 'GET',
      path: '/api/runtime/status',
      status: 200,
      cfRay: '0123456789abcdef-TST',
      identity: 'token',
    });
    expect(JSON.stringify(audit.mock.calls).includes(token)).toBe(false);
  });
  it('logs failed remote authentication once and never trusts the unsigned email', async () => {
    await serve();
    expect(
      (
        await request('/api/runtime/status?private=true', {
          'cf-ray': '0123456789abcdef-TST',
          'cf-access-authenticated-user-email': 'fixture@invalid',
        })
      ).status
    ).toBe(401);
    expect(auditRow()).toMatchObject({ status: 401, identity: 'anonymous' });
    expect(JSON.stringify(audit.mock.calls).includes('fixture@invalid')).toBe(false);
    audit.mockClear();
    expect((await request('/api/runtime/status', {}, '192.0.2.2')).status).toBe(401);
    expect(auditRow()).toMatchObject({ status: 401, identity: 'anonymous' });
  });
  it('uses a short hash only after JWT signature and claims verification', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://127.0.0.1:19010';
    vi.stubEnv('MAMA_CF_ACCESS_ISSUER', issuer);
    vi.stubEnv('MAMA_CF_ACCESS_AUD', 'fixture');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture' }] }),
      }))
    );
    const email = 'fixture@invalid';
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid: 'fixture' })}.${encode({ iss: issuer, aud: 'fixture', exp: Date.now() / 1000 + 120, email })}`;
    const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
    await serve({ getRuntimeStatus: () => ({ running: true }) as never });
    expect(
      (
        await request('/api/runtime/status', {
          'cf-ray': '0123456789abcdef-TST',
          'cf-access-jwt-assertion': assertion,
          'cf-access-authenticated-user-email': 'forged@invalid',
        })
      ).status
    ).toBe(200);
    expect(auditRow().identity).toBe(
      `access:${createHash('sha256').update(email).digest('hex').slice(0, 12)}`
    );
    expect(JSON.stringify(audit.mock.calls).includes(email)).toBe(false);
    expect(JSON.stringify(audit.mock.calls).includes(assertion)).toBe(false);
  });
  it.each([
    ['/health', 'GET'],
    ['/', 'GET'],
    ['/api/runtime/status', 'OPTIONS'],
  ])('audits public tunnelled routes without closing them %#', async (path, method) => {
    await serve();
    const response = await request(path, { 'cf-ray': '0123456789abcdef-TST' }, '127.0.0.1', method);
    expect(response.status).toBeLessThan(400);
    expect(auditRow()).toMatchObject({
      path,
      method,
      status: response.status,
      identity: 'anonymous',
    });
  });
  it('preserves ordinary content hashes and rejects non-protocol ray values', async () => {
    const hash = 'a'.repeat(64);
    await serve();
    await request(`/api/${hash}`, { 'cf-ray': 'fixture.invalid' });
    expect(auditRow()).toMatchObject({ path: `/api/${hash}`, cfRay: '[invalid]' });
  });
  it('audits a tunnel Host rejection once without authenticating it', async () => {
    await serve();
    await request('/health', { host: 'fixture.invalid', 'cf-ray': '0123456789abcdef-TST' });
    expect(auditRow()).toMatchObject({ status: 421, identity: 'anonymous' });
  });
  it('constrains attacker-controlled audit fields', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    await serve();
    await request(`/api/${token}?secret=${token}`, { 'cf-ray': `${token}\nforged=1` });
    const output = String(audit.mock.calls[0]?.[0]);
    expect(output.includes(token)).toBe(false);
    expect(output.includes('\n')).toBe(false);
    expect(output.length).toBeLessThan(1500);
  });
  it('uses recallable credential shapes in audit paths and complete key blocks in errors', async () => {
    const credential = 'gh' + 'p_' + 'b'.repeat(30);
    const keyBody = 'synthetic-key-material';
    const key = '-----BEGIN ' + 'PRIVATE KEY-----\n' + keyBody + '\n-----END ' + 'PRIVATE KEY-----';
    await serve({
      getRuntimeStatus: () => {
        throw new Error(`diagnostic ${key}`);
      },
    });
    await request(`/api/${credential}`, { 'cf-ray': '0123456789abcdef-TST' });
    expect(JSON.stringify(audit.mock.calls).includes(credential)).toBe(false);
    await request();
    expect(JSON.stringify(errors.mock.calls).includes(keyBody)).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).toContain('diagnostic');
  });
  it('returns a generic internal error and logs safe diagnostic metadata', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    await serve({
      getRuntimeStatus: () => {
        throw Object.assign(
          new Error(
            `internal fixture detail ${token} https://fixture.invalid /private/synthetic/config.yaml`
          ),
          { code: 'EACCES' }
        );
      },
    });
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.body.includes(token)).toBe(false);
    expect(response.body.includes('internal fixture detail')).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls).includes(token)).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).toContain('EACCES');
    expect(JSON.stringify(errors.mock.calls)).toContain('internal fixture detail');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('fixture.invalid');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('/private/synthetic');
  });
  it('redacts Basic authorization and quoted secret fields while retaining diagnostics', async () => {
    const basic = Buffer.from('synthetic-user:synthetic-password').toString('base64');
    const password = randomBytes(18).toString('hex');
    await serve({
      getRuntimeStatus: () => {
        throw new Error(
          `diagnostic Authorization: Basic ${basic} payload={"password":"${password}"}`
        );
      },
    });
    const result = await request();
    expect(result.status).toBe(500);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged.includes(basic)).toBe(false);
    expect(logged.includes(password)).toBe(false);
    expect(logged).toContain('diagnostic');
  });
  it('also hides internal action failures wrapped as viewer HTTP errors', async () => {
    dispatch.mockResolvedValue({
      status: 'failed',
      error: {
        kind: 'execution_failed',
        code: 'INTERNAL_DETAIL',
        message: 'internal storage diagnostic',
      },
    });
    await serve();
    const result = await request('/api/operator/tasks');
    expect(result.status).toBe(502);
    expect(result.body).not.toContain('internal storage diagnostic');
    expect(JSON.parse(result.body).message).toBe('Internal server error');
    expect(JSON.stringify(errors.mock.calls)).toContain('internal storage diagnostic');
  });
});

describe('bounded daemon log reads', () => {
  function logFile(content: string) {
    const root = fs.mkdtempSync(join(tmpdir(), 'viewer-log-'));
    roots.push(root);
    const path = join(root, 'daemon.log');
    fs.writeFileSync(path, content);
    return path;
  }
  it('reads only a bounded tail from a large file and preserves complete UTF-8 lines', async () => {
    const logPath = logFile('old line\n'.repeat(150000) + '\uCCAB\uC9F8\r\n\uB458\uC9F8\n');
    await serve({ logPath });
    const wholeFile = vi.mocked(fs.readFileSync).mockClear();
    const reads = vi.mocked(fs.readSync).mockClear();
    const result = await request('/api/logs/daemon?limit=2');
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.lines).toEqual(['\uCCAB\uC9F8', '\uB458\uC9F8']);
    expect(body.truncated).toBe(true);
    expect(wholeFile.mock.calls.some(([path]) => path === logPath)).toBe(false);
    expect(
      reads.mock.results.reduce((sum, item) => sum + Number(item.value), 0)
    ).toBeLessThanOrEqual(256 * 1024);
  });
  it('honors the viewer tail parameter and does not read unchanged files', async () => {
    const logPath = logFile('one\n\ntwo\r\nthree\n');
    await serve({ logPath });
    expect(JSON.parse((await request('/api/logs/daemon?tail=2')).body).lines).toEqual([
      'two',
      'three',
    ]);
    const reads = vi.mocked(fs.readSync).mockClear();
    expect(
      JSON.parse((await request(`/api/logs/daemon?since=${Date.now() + 10000}`)).body).lines
    ).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });
  it('keeps reading within the byte ceiling to return nonempty lines separated by blanks', async () => {
    await serve({ logPath: logFile('first\n' + '\n'.repeat(20000) + 'last\n') });
    const body = JSON.parse((await request('/api/logs/daemon?limit=2')).body);
    expect(body.lines).toEqual(['first', 'last']);
  });
  it('reports truncation instead of returning a partial oversized line', async () => {
    await serve({ logPath: logFile('x'.repeat(500000) + '\nlast\n') });
    const body = JSON.parse((await request('/api/logs/daemon?limit=2')).body);
    expect(body.lines).toEqual(['last']);
    expect(body.truncated).toBe(true);
  });
});
