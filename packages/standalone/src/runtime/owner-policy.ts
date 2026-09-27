import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OwnerPolicySnapshot {
  content: string | null;
  fingerprint: string;
  loaded: boolean;
}

export type OwnerPolicyProvider = () => OwnerPolicySnapshot;

const OWNER_POLICY_FILENAME = 'owner-policy.md';

function fingerprint(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function ownerPolicyPath(mamaRoot: string): string {
  return join(mamaRoot, OWNER_POLICY_FILENAME);
}

export function readOwnerPolicy(mamaRoot: string): OwnerPolicySnapshot {
  try {
    const bytes = readFileSync(ownerPolicyPath(mamaRoot));
    return {
      content: bytes.toString('utf8'),
      fingerprint: fingerprint(bytes),
      loaded: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const bytes = Buffer.alloc(0);
    return { content: null, fingerprint: fingerprint(bytes), loaded: false };
  }
}

export function createOwnerPolicyProvider(mamaRoot: string): OwnerPolicyProvider {
  return () => readOwnerPolicy(mamaRoot);
}
