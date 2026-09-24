import { canonicalizeJSON } from '../canonicalize.js';
import type { JsonValue } from '../memory/judgment-types.js';

/** Reject lossy JavaScript values before a producer receives a durable receipt. */
export function encodeStimulusPayload(value: unknown): string | null {
  if (value === undefined) return null;
  const ancestors = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) {
      throw new Error('Mailbox payload must contain only JSON values');
    }
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      throw new Error('Mailbox payload requires plain JSON objects');
    }
    if (ancestors.has(item)) throw new Error('Mailbox payload cannot contain cycles');
    ancestors.add(item);
    const keys = Reflect.ownKeys(item).filter((key) => !array || key !== 'length');
    if (array && (keys.length !== item.length || keys.some((key, i) => key !== String(i)))) {
      throw new Error('Mailbox payload requires dense JSON arrays');
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('Mailbox payload requires enumerable JSON data properties');
      }
      visit(descriptor.value);
    }
    ancestors.delete(item);
  };
  visit(value);
  return canonicalizeJSON(value);
}

export function decodeStimulusPayload(encoded: string | null): JsonValue | undefined {
  if (encoded === null) return undefined;
  const value: unknown = JSON.parse(encoded);
  encodeStimulusPayload(value);
  return value as JsonValue;
}
