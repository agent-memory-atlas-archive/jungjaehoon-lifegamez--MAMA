import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrelloConnector } from '../../src/connectors/trello/index.js';

describe('Trello initial-window regression', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does not turn an old open card into a new source item', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trello-window-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-key');
    vi.stubEnv('MAMA_TRELLO_TOKEN', 'fixture-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 'list-key',
            name: 'list-display',
            cards: [
              {
                id: 'card-key',
                name: 'old-card',
                idMembers: [],
                labels: [],
                dateLastActivity: '2020-01-01T00:00:00.000Z',
              },
            ],
          },
        ],
      })
    );
    try {
      const connector = new TrelloConnector(
        {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'channel-key': { role: 'hub', name: 'board-display', boardId: 'board-key' } },
          auth: { type: 'token', tokenName: 'MAMA_TRELLO_TOKEN' },
        },
        join(root, 'state.json')
      );
      await connector.init();
      expect(await connector.poll(new Date('2024-01-01T00:00:00.000Z'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
