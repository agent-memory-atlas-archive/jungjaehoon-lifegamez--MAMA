import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAMAServer, validateEnvironment } from '../../src/server.js';

const SERVER_SOURCE = readFileSync(join(process.cwd(), 'src/server.js'), 'utf8');
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8')
).version;

describe('development-memory environment', () => {
  const originalEnv = { ...process.env };

  const restoreEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  };
  beforeEach(restoreEnv);
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it.each(['development', 'production'])('uses the plugin default in %s', async (mode) => {
    process.env.NODE_ENV = mode;
    delete process.env.MAMA_DB_PATH;
    const expected = join(process.env.HOME, '.claude', 'mama-memory.db');
    expect(validateEnvironment()).toBe(expected);
    expect(process.env.MAMA_DB_PATH).toBe(expected);
    const { usePluginDatabase } = await import('../../../claude-code-plugin/scripts/db-path.js');
    delete process.env.MAMA_DB_PATH;
    expect(usePluginDatabase()).toBe(expected);
  });

  it('preserves an explicit MAMA_DB_PATH in both consumers', async () => {
    const expected = join(process.env.HOME, 'explicit.db');
    process.env.MAMA_DB_PATH = expected;
    expect(validateEnvironment()).toBe(expected);
    const { usePluginDatabase } = await import('../../../claude-code-plugin/scripts/db-path.js');
    expect(usePluginDatabase()).toBe(expected);
  });

  it('honours the older MAMA_DATABASE_PATH name the core still reads, in server and hooks alike', async () => {
    delete process.env.MAMA_DB_PATH;
    const expected = join(process.env.HOME, 'older-name.db');
    process.env.MAMA_DATABASE_PATH = expected;
    expect(validateEnvironment()).toBe(expected);
    expect(process.env.MAMA_DB_PATH).toBeUndefined();
    const { usePluginDatabase } = await import('../../../claude-code-plugin/scripts/db-path.js');
    expect(usePluginDatabase()).toBe(expected);
    delete process.env.MAMA_DATABASE_PATH;
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
