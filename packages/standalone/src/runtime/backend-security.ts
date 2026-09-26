import { resolve } from 'node:path';

/** CLI authentication lives in the backend homes. No secret-shaped daemon variable is needed.
 * Non-secret CLAUDE_CODE_* messaging/settings variables remain available to native children.
 */
export function backendEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      // MAX_THINKING_TOKENS is a budget count the Claude CLI reads, not a credential.
      ([name]) =>
        name === 'MAX_THINKING_TOKENS' || !/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name)
    )
  );
}

/** Paths are supplied by the product, never discovered by the shared engine. */
export function credentialReadPaths(runtimeRoot: string, codexHome?: string): string[] {
  return [
    ...new Set([
      resolve(runtimeRoot, 'auth.env'),
      resolve(runtimeRoot, 'config.yaml'),
      resolve(runtimeRoot, 'runtime'),
      resolve(runtimeRoot, '.codex'),
      ...(codexHome ? [resolve(codexHome)] : []),
    ]),
  ];
}
