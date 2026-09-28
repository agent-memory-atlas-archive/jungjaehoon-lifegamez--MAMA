import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The owner's words that bring the full report in chat. The owner teaches them through a
 * correction; the host only matches them, as Kagemusha's chat report routing does.
 */
export interface ReportPhraseSetting {
  get(): readonly string[];
  set(phrases: readonly string[]): void;
}

/** A phrase's identity for matching, removal and duplicates: spaces and case ignored. */
export function phraseKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

function readPhrases(path: string): string[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { phrases?: unknown };
  if (
    !Array.isArray(parsed.phrases) ||
    !parsed.phrases.every((phrase) => typeof phrase === 'string' && phraseKey(phrase) !== '')
  )
    throw new Error(`${path} must hold { "phrases": [nonblank strings] }`);
  return parsed.phrases;
}

export function createReportPhraseSetting(path: string): ReportPhraseSetting {
  // A malformed file stops startup instead of failing every owner message later.
  readPhrases(path);
  return {
    get: () => readPhrases(path),
    set: (phrases) => {
      const temporary = join(dirname(path), `.full-report-phrases-${randomUUID()}.tmp`);
      writeFileSync(temporary, `${JSON.stringify({ phrases }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

/** Whether an owner message contains a registered phrase, ignoring spaces and case. */
export function asksForFullReport(text: string, phrases: readonly string[]): boolean {
  const message = phraseKey(text);
  return phrases.some((phrase) => message.includes(phraseKey(phrase)));
}
