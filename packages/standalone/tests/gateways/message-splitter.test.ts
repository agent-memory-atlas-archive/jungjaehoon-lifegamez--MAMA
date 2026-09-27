import { describe, expect, it } from 'vitest';
import { splitMessage } from '../../src/gateways/message-splitter.js';

describe('Telegram message splitting helpers', () => {
  it('prefers readable boundaries and keeps every chunk within the limit', () => {
    const chunks = splitMessage('one two three four five', { maxLength: 9 });
    expect(chunks).toEqual(['one two', 'three', 'four five']);
    expect(chunks.every((chunk) => chunk.length <= 9)).toBe(true);
  });
});
