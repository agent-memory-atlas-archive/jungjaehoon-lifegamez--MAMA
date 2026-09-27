import { describe, expect, it } from 'vitest';
import {
  createTimeZoneSetting,
  epochAtLocalDateTime,
  epochForCalendarValue,
  localDateKey,
} from '../../src/runtime/timezone.js';

describe('owner timezone setting', () => {
  it('converts local wall times and reads changes through one holder', () => {
    const setting = createTimeZoneSetting('America/Los_Angeles');
    expect(epochAtLocalDateTime('2026-09-27T00:00:00', setting.get())).toBe(
      Date.parse('2026-09-27T07:00:00Z')
    );
    expect(localDateKey(Date.parse('2026-09-27T06:30:00Z'), setting.get())).toBe('2026-09-26');
    setting.set('Europe/Paris');
    expect(epochAtLocalDateTime('2026-09-27T00:00:00', setting.get())).toBe(
      Date.parse('2026-09-26T22:00:00Z')
    );
  });

  it('rejects calendar values with an unknown stored kind', () => {
    expect(() => epochForCalendarValue('20260927T120000', 'unknown', undefined, 'UTC')).toThrow(
      'unknown calendar value kind "unknown"'
    );
  });
});
