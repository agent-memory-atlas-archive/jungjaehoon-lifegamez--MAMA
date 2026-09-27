import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { saveCheckpoint, loadCheckpoint } from '../../src/mama-api.js';
import { saveCheckpointInAdapter } from '../../src/memory/api.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

let dbPath: string;
beforeAll(async () => {
  dbPath = await initTestDB('checkpoint-secret');
});
beforeEach(() => {
  getAdapter().prepare('DELETE FROM checkpoints').run();
});
afterAll(async () => {
  await cleanupTestDB(dbPath);
});

describe.each(['public', 'adapter'] as const)('checkpoint secret boundary (%s)', (route) => {
  it.each(['summary', 'open_files', 'next_steps'] as const)(
    'refuses credentials in %s before persistence',
    async (field) => {
      const credential = 'gh' + 'p_' + 'a'.repeat(30);
      const input = {
        summary: 'resume work',
        open_files: ['src/fixture.ts'],
        next_steps: 'run checks',
        [field]: field === 'open_files' ? [credential] : credential,
      };
      const save = () =>
        route === 'public'
          ? saveCheckpoint(input.summary, input.open_files, input.next_steps)
          : saveCheckpointInAdapter(
              getAdapter(),
              input.summary,
              input.open_files,
              input.next_steps
            );
      await expect(save()).rejects.toMatchObject({ name: 'secret_material_refused' });
      await expect(save()).rejects.not.toThrow(credential);
      expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM checkpoints').get()).toMatchObject(
        { count: 0 }
      );
    }
  );
});

it('round-trips a clean checkpoint through the direct public API', async () => {
  await saveCheckpoint('resume work', ['src/fixture.ts'], 'run checks');
  expect(await loadCheckpoint()).toMatchObject({
    summary: 'resume work',
    open_files: ['src/fixture.ts'],
    next_steps: 'run checks',
  });
});
