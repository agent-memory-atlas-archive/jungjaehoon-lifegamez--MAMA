import { describe, expect, it } from 'vitest';
import { formatTelegramMessage } from '../../src/gateways/telegram-format.js';

describe('Telegram formatting', () => {
  it('converts the supported HTML subset to text entities', () => {
    expect(formatTelegramMessage('<b>heading</b> body')[0]).toEqual({
      text: 'heading body',
      entities: [{ type: 'bold', offset: 0, length: 7 }],
    });
  });

  it('splits formatted text while keeping entity offsets local to each chunk', () => {
    const chunks = formatTelegramMessage('<b>abcdefghij</b>', 5);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['abcde', 'fghij']);
    expect(chunks[0]?.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
    expect(chunks[1]?.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
  });
});
