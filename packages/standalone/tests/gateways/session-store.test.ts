import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { SessionStore } from '../../src/gateways/session-store.js';

describe('SessionStore', () => {
  let db: SQLiteDatabase;
  let store: SessionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
  });

  afterEach(() => store.close());

  it('creates one durable session per source and channel', () => {
    const first = store.getOrCreate('telegram', '7', '9');
    const second = store.getOrCreate('telegram', '7', '9');
    expect(second.id).toBe(first.id);
    expect(store.listSessions('telegram')).toHaveLength(1);
  });

  it('persists a user turn and its assistant response', () => {
    const session = store.getOrCreate('telegram', '7', '9');
    store.appendMessage(
      session.id,
      { role: 'user', content: 'question', timestamp: 1 },
      { sourceMessageRef: 'telegram:7:11' }
    );
    store.finalizeTurn(session.id, 'telegram:7:11', 'answer');
    expect(store.findTurnBySourceMessageRef(session.id, 'telegram:7:11')).toMatchObject({
      user: 'question',
      bot: 'answer',
      state: 'final',
    });
  });
});
