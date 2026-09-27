import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { listSecrets, secretName, updateSecrets } from '../../src/cli/secrets.js';

describe('iCal secret names', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('accepts configured feed names and lists the saved variable without exposing its value', () => {
    root = mkdtempSync(join(tmpdir(), 'mama-secret-ical-'));
    const name = secretName('MAMA_ICAL_URL_PUBLIC_HOLIDAYS');
    updateSecrets(root, { [name]: 'https://example.invalid/private.ics' });
    expect(listSecrets(root)).toEqual([name]);
  });

  it('rejects secret variable suffixes outside uppercase feed identifiers', () => {
    expect(() => secretName('MAMA_ICAL_URL_private')).toThrow();
    expect(() => secretName('MAMA_ICAL_URL_')).toThrow();
  });
});
