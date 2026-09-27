import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveResponseBody } from '../../src/connectors/framework/attachment-io.js';

let root: string;
let target: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'attachment-limit-'));
  target = join(root, 'attachment.bin');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('attachment response storage', () => {
  it('does not follow or remove an existing temporary symlink', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    const outside = join(root, 'outside');
    writeFileSync(outside, 'untouched');
    const temporary = `${target}.${process.pid}.123.part`;
    symlinkSync(outside, temporary);
    await expect(saveResponseBody(new Response('replacement'), target, root)).rejects.toThrow(
      /saving body/
    );
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(lstatSync(temporary).isSymbolicLink()).toBe(true);
  });

  it('replaces an earlier download of the same attachment', async () => {
    writeFileSync(target, 'previous version');
    expect(await saveResponseBody(new Response('new version'), target, root)).toBe(11);
    expect(readFileSync(target, 'utf8')).toBe('new version');
    expect(readdirSync(root)).toEqual(['attachment.bin']);
  });

  it('replaces a symlink at the target name instead of writing through it', async () => {
    const outside = join(root, 'outside');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, target);
    await saveResponseBody(new Response('replacement'), target, root);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('replacement');
  });

  it('saves exactly 50 MiB without a content-length header', async () => {
    const response = new Response(new Uint8Array(50 * 1024 * 1024));
    expect(await saveResponseBody(response, target, root)).toBe(52_428_800);
    expect(statSync(target).size).toBe(52_428_800);
    expect(readdirSync(root)).toEqual(['attachment.bin']);
  });

  it('rejects an oversized content-length before reading and cancels the body', async () => {
    let pulled = false;
    let cancelled = false;
    const response = new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { 'content-length': '52428801' } }
    );
    await expect(saveResponseBody(response, target, root)).rejects.toThrow(
      /50 MiB \(52428800 bytes\)/
    );
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(['missing', 'underreported'])(
    'caps streamed bytes with a %s content-length and retains the previous file',
    async (kind) => {
      writeFileSync(target, 'previous version');
      let chunks = 0;
      let cancelled = false;
      const response = new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (chunks++ === 0) controller.enqueue(new Uint8Array(50 * 1024 * 1024));
              else if (chunks === 2) controller.enqueue(new Uint8Array(1));
              // Keep the upstream body open so a limit rejection must cancel it.
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 }
        ),
        kind === 'missing' ? {} : { headers: { 'content-length': '1' } }
      );
      await expect(saveResponseBody(response, target, root)).rejects.toThrow(
        /50 MiB \(52428800 bytes\)/
      );
      expect(cancelled).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('previous version');
      expect(readdirSync(root)).toEqual(['attachment.bin']);
    }
  );

  it('cleans up a failed body without exposing its upstream error details', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error('private-response-detail'));
        },
      })
    );
    await expect(saveResponseBody(response, target, root)).rejects.toThrow(
      /^attachment download failed while saving body$/
    );
    expect(readdirSync(root)).toEqual([]);
  });
});
