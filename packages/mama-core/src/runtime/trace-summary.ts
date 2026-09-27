import { redactSecretPatterns } from '../memory/secret-filter.js';

const SECRET_FIELD =
  /(?:authorization|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const SECRET_ASSIGNMENT =
  /\b([\w-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)[\w-]*(?:\\?["'])?\s*[=:]\s*)(?:\\"[^\r\n]*?\\"|"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]]+)/gi;

/** Shared raw diagnostic redaction; callers choose their own output bounds. */
export function redactTraceText(value: string): string {
  return redactSecretPatterns(value)
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) {
          url.username = '[REDACTED]';
          url.password = '';
        }
        for (const key of [...url.searchParams.keys()]) {
          if (SECRET_FIELD.test(key)) url.searchParams.set(key, '[REDACTED]');
        }
        // URL fragments are not sent to servers and do not help diagnose tool execution.
        url.hash = '';
        return url.toString();
      } catch {
        return '[INVALID-URL]';
      }
    })
    .replace(
      /(--[\w-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)[\w-]*\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]]+)/gi,
      '$1[REDACTED]'
    )
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(
      /\b(Authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s,"';]+/gi,
      '$1[REDACTED]'
    );
}

/** Bounded diagnostics only: never mutate the executed input or stored evidence. */
export function traceSummary(value: unknown): string | null {
  if (value === undefined) return null;
  const seen = new WeakSet<object>();
  let remaining = 4_000;
  const text = (value: string): string => {
    const safe = redactTraceText(value);
    const result = safe.slice(0, Math.max(0, remaining));
    remaining -= result.length;
    return result;
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 6) return '[TRUNCATED]';
    if (typeof item === 'string') return text(item);
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '[CIRCULAR]';
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 40).map((entry) => visit(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 40)
        .map(([key, entry]) => [
          text(key),
          SECRET_FIELD.test(key) ? '[REDACTED]' : visit(entry, depth + 1),
        ])
    );
  };
  try {
    const serialized = JSON.stringify(visit(value, 0)) ?? '';
    return serialized.length <= 4_000 ? serialized : `${serialized.slice(0, 3_997)}...`;
  } catch {
    return '[UNSERIALIZABLE]';
  }
}
