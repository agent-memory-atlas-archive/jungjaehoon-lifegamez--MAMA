import { describe, expect, it } from 'vitest';
import { traceSummary } from '../../src/runtime/trace-summary.js';

describe('diagnostic input redaction', () => {
  it('masks a JWT-shaped value without needing a secret-named field', () => {
    const assertion = ['eyJ' + 'a'.repeat(20), 'b'.repeat(24), 'c'.repeat(32)].join('.');
    expect(traceSummary({ command: `echo ${assertion}` })?.includes(assertion)).toBe(false);
  });
  it('masks flags, URL credentials, query secrets and nested values without masking hashes', () => {
    const value = ['synthetic', 'private'].join('-');
    const digest = 'a'.repeat(64);
    const inputs = [
      { command: `curl -H 'Authorization: Basic ${value}'` },
      { command: `echo '{"api_key":"${value}"}'` },
      { command: 'curl -d "{\\"password\\":\\"' + value + '\\"}"' },
      { command: `tool --token ${value} --password '${value}' digest=${digest}` },
      { url: `https://user:${value}@example.invalid/path?api_key=${value}&q=fixture#${value}` },
      { command: `curl 'https://user:${value}@example.invalid/path?token=${value}'` },
      { headers: { Authorization: `Bearer ${value}` }, nested: [{ private_key: value }], digest },
    ];
    for (const input of inputs) expect(traceSummary(input)?.includes(value)).toBe(false);
    expect(traceSummary(inputs)).toContain(digest);
  });
  it('bounds circular/deep input without mutating execution input', () => {
    const input: Record<string, unknown> = { content: 'x'.repeat(6000) };
    input.self = input;
    expect(traceSummary(input)!.length).toBeLessThanOrEqual(4000);
    expect((input.content as string).length).toBe(6000);
  });
});
