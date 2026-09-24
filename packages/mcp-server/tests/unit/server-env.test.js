import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAMAServer } from '../../src/server.js';

const SERVER_SOURCE = readFileSync(join(process.cwd(), 'src/server.js'), 'utf8');
const RUNTIME_CLIENT_SOURCE = readFileSync(join(process.cwd(), 'src/runtime-client.js'), 'utf8');
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8')
).version;

describe('Runtime client architecture', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('owns no database: no MAMA_DB_PATH, openDatabase, or direct core API imports', () => {
    // The runtime owns the store — this process is a stdio protocol adapter.
    expect(SERVER_SOURCE).not.toMatch(/MAMA_DB_PATH/);
    expect(SERVER_SOURCE).not.toMatch(/openDatabase|initDB|getAdapter|closeDB/);
    expect(SERVER_SOURCE).not.toMatch(/createMamaApi|mama-api|db-manager/);
    expect(SERVER_SOURCE).not.toMatch(/bindRuntime\(this\.dbHandle|dbHandle/);
  });

  it('binds the shared runtime client over the socket path', () => {
    expect(SERVER_SOURCE).toContain("require('./runtime-client.js')");
    expect(SERVER_SOURCE).toMatch(/openRuntimeClient/);
    expect(SERVER_SOURCE).toMatch(/callAction/);
    // Tool calls dispatch through the bound caller, not a local adapter.
    expect(SERVER_SOURCE).toMatch(/this\.call\('/);
  });

  it('resolves MAMA_HOME for the socket, journal, and credential paths', () => {
    expect(RUNTIME_CLIENT_SOURCE).toMatch(/MAMA_HOME/);
    expect(RUNTIME_CLIENT_SOURCE).toMatch(/runtime\.sock/);
    expect(RUNTIME_CLIENT_SOURCE).toMatch(/client-journal\.jsonl/);
    expect(RUNTIME_CLIENT_SOURCE).toMatch(/session-credential/);
  });

  it('keeps failed and unknown outcomes distinct from success', () => {
    // callAction must not collapse a failed action into an empty success —
    // the error carries the server's code and the operation id for
    // operation.get settlement.
    expect(RUNTIME_CLIENT_SOURCE).toMatch(/operationId/);
    expect(RUNTIME_CLIENT_SOURCE).toMatch(/ipc_unavailable/);
    expect(RUNTIME_CLIENT_SOURCE).not.toMatch(/status === 'failed'.*return\s+\{\}/s);
  });
});

describe('PR2B: stdio-only MCP runtime', () => {
  it('reports the installed package version through MCP server metadata', () => {
    const server = new MAMAServer();

    expect(server.server._serverInfo).toEqual({
      name: 'mama-server',
      version: PACKAGE_VERSION,
    });
  });

  it('has no HTTP embedding opt-in, import, probe, notice, or startup branch', () => {
    expect(SERVER_SOURCE).not.toMatch(
      /MAMA_MCP_START_HTTP_EMBEDDING|MAMA_EMBEDDING_PORT|embedding-server/
    );
    expect(SERVER_SOURCE).not.toMatch(
      /isEmbeddingServerRunning|startEmbeddingServer|warmModel|migration_notice/
    );
    expect(SERVER_SOURCE).not.toMatch(/require\(['"]http['"]\)/);
    expect(SERVER_SOURCE).not.toMatch(/MAMA_SERVER_TOKEN|MAMA_SERVER_PORT|setupLogging/);
  });

  it('ignores the retired opt-in even when the environment variable is set', () => {
    const originalOptIn = process.env.MAMA_MCP_START_HTTP_EMBEDDING;
    try {
      process.env.MAMA_MCP_START_HTTP_EMBEDDING = 'true';

      const server = new MAMAServer();

      expect(server).not.toHaveProperty('legacyHttpEmbeddingMode');
      expect(SERVER_SOURCE).toContain('StdioServerTransport');
    } finally {
      if (originalOptIn === undefined) {
        delete process.env.MAMA_MCP_START_HTTP_EMBEDDING;
      } else {
        process.env.MAMA_MCP_START_HTTP_EMBEDDING = originalOptIn;
      }
    }
  });
});
