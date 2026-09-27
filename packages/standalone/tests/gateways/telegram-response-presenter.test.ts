import { describe, expect, it, vi } from 'vitest';
import { TelegramResponsePresenter } from '../../src/gateways/telegram-response-presenter.js';

describe('TelegramResponsePresenter', () => {
  it('sends a placeholder and edits it to the final response', async () => {
    const send = vi.fn().mockResolvedValue('message-1');
    const edit = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const presenter = new TelegramResponsePresenter(
      { send, edit, delete: remove },
      { throttleMs: 1 }
    );

    await presenter.start();
    await presenter.finalize('final answer');

    expect(send).toHaveBeenCalledWith({ text: '⏳', entities: [] });
    expect(edit).toHaveBeenCalledWith('message-1', {
      text: 'final answer',
      entities: [],
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('sends later chunks when the final answer exceeds one Telegram message', async () => {
    const send = vi.fn().mockResolvedValueOnce('message-1').mockResolvedValueOnce('message-2');
    const edit = vi.fn().mockResolvedValue(undefined);
    const presenter = new TelegramResponsePresenter(
      { send, edit, delete: vi.fn().mockResolvedValue(undefined) },
      { maxLength: 5 }
    );

    await presenter.start();
    await presenter.finalize('one two three');

    expect(edit).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ text: 'ree', entities: [] });
  });
});
