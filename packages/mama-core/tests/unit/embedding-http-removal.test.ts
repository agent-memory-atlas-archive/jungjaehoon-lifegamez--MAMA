import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('PR2B: HTTP embedding runtime removal', () => {
  it('keeps the in-process embeddings export without publishing HTTP runtime entrypoints', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const rootSource = readFileSync(join(PACKAGE_ROOT, 'src/index.ts'), 'utf8');

    // The subpath names a capability, not a file: W11 moved the module under
    // `embedding/` and the published name stayed, because the plugin hooks
    // import it by that name.
    expect(packageJson.exports['./embeddings']).toBe('./dist/embedding/embedder.js');
    expect(packageJson.exports).not.toHaveProperty('./embedding-client');
    expect(packageJson.exports).not.toHaveProperty('./embedding-server');
    expect(packageJson.dependencies).not.toHaveProperty('ws');
    expect(packageJson.devDependencies).not.toHaveProperty('@types/ws');
    expect(packageJson.scripts.build).toBe('node scripts/clean-dist.mjs && tsc');
    expect(rootSource).not.toMatch(/embedding-client|embedding-server|getServerPort|DEFAULT_PORT/);
  });

  it('does not ship the retired HTTP client, server, or mobile runtime sources', () => {
    const removedPaths = [
      'src/embedding-client.ts',
      'src/embedding-server/index.ts',
      'src/embedding-server/mobile/auth.ts',
      'src/embedding-server/mobile/daemon.ts',
      'src/embedding-server/mobile/output-parser.ts',
      'src/embedding-server/mobile/session-api.ts',
      'src/embedding-server/mobile/session-manager.ts',
      'src/embedding-server/mobile/websocket-handler.ts',
    ];

    for (const path of removedPaths) {
      expect(existsSync(join(PACKAGE_ROOT, path)), path).toBe(false);
    }
  });
});
