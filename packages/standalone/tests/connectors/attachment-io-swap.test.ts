import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const swap = vi.hoisted(() => ({ run: undefined as undefined | (() => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      const pending = swap.run;
      swap.run = undefined;
      pending?.();
      return fd;
    },
  };
});

const { saveAttachmentBytes } = await import('../../src/connectors/framework/attachment-io.js');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'attachment-swap-'));
  roots.push(root);
  return root;
}

describe('attachment writes under a changing workspace', () => {
  it('writes no bytes when the directory is swapped after the temp file opens', () => {
    const root = workspace();
    const files = join(root, 'files');
    const other = join(root, 'other');
    fs.mkdirSync(files);
    fs.mkdirSync(other);
    swap.run = () => {
      fs.renameSync(files, join(root, 'files-old'));
      fs.symlinkSync(other, files);
    };
    // The rechecked directory no longer holds the opened file: refused before any byte is written.
    expect(() => saveAttachmentBytes(root, join(files, 'a.bin'), Buffer.from('secret'))).toThrow();
    expect(fs.readdirSync(other)).toEqual([]);
    const left = fs.readdirSync(join(root, 'files-old'));
    expect(left).toHaveLength(1);
    expect(fs.statSync(join(root, 'files-old', left[0]!)).size).toBe(0);
  });

  it('removes the temp file when the final rename fails', () => {
    const root = workspace();
    const files = join(root, 'files');
    fs.mkdirSync(join(files, 'a.bin'), { recursive: true });
    fs.writeFileSync(join(files, 'a.bin', 'keep'), 'x');
    expect(() => saveAttachmentBytes(root, join(files, 'a.bin'), Buffer.from('data'))).toThrow();
    expect(fs.readdirSync(files)).toEqual(['a.bin']);
  });
});
