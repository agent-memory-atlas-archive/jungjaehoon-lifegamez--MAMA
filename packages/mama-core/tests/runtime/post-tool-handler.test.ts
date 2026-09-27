/**
 * The post-tool handler's MECHANISM, which is all core owns of it.
 *
 * It used to be tested through a standalone source that read contracts out of
 * edited source code - which tool names count as edits, which paths are skipped,
 * the five shapes a contract takes. That source and its extractor are deleted
 * (nothing in the product ever enabled the handler), and its vocabulary went
 * with them. What is left here is the part the class itself decides: whether it
 * runs at all, which tool results it reads, how many candidates it writes, and
 * that it looks before it writes.
 *
 * A stub source stands in for the vocabulary, which is the shape the class
 * always expected: candidates(content, filePath).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PostToolHandler,
  type PostToolMemoryCandidate,
  type PostToolMemorySource,
} from '../../src/runtime/post-tool-handler.js';

const wiring = {
  editTools: ['Write', 'Edit'],
  searchTool: 'memory.search',
  saveTool: 'memory.save',
};

function sourceYielding(count: number): PostToolMemorySource {
  return {
    candidates: (_content, filePath) =>
      Array.from({ length: count }, (_value, index) => ({
        topic: `${filePath}#${index}`,
        decision: `candidate ${index}`,
        reasoning: 'stub',
      })) as PostToolMemoryCandidate[],
  };
}

/** The handler is fire-and-forget; its work lands after the microtask queue drains. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('PostToolHandler', () => {
  let executeTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeTool = vi.fn().mockResolvedValue({ success: true, results: [] });
  });

  it('returns nothing and never throws, whatever it is handed', () => {
    const handler = new PostToolHandler(
      executeTool,
      { enabled: true, ...wiring },
      sourceYielding(1)
    );

    expect(handler.processInBackground('Write', { path: 'a.ts' }, 'body')).toBeUndefined();
    expect(() => handler.processInBackground('Write', null, undefined)).not.toThrow();
  });

  it('does nothing when disabled', async () => {
    const handler = new PostToolHandler(
      executeTool,
      { enabled: false, ...wiring },
      sourceYielding(1)
    );

    handler.processInBackground('Write', { path: 'a.ts' }, 'body');
    await settle();

    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does nothing without a source - which is what deleting one leaves behind', async () => {
    const handler = new PostToolHandler(executeTool, { enabled: true, ...wiring }, null);

    handler.processInBackground('Write', { path: 'a.ts' }, 'body');
    await settle();

    expect(executeTool).not.toHaveBeenCalled();
  });

  it('reads only the tool results its edit list names', async () => {
    const handler = new PostToolHandler(
      executeTool,
      { enabled: true, ...wiring },
      sourceYielding(1)
    );

    handler.processInBackground('Read', { path: 'a.ts' }, 'body');
    await settle();
    expect(executeTool).not.toHaveBeenCalled();

    handler.processInBackground('Write', { path: 'a.ts' }, 'body');
    await settle();
    expect(executeTool).toHaveBeenCalled();
  });

  it('looks for an existing record before writing one', async () => {
    const handler = new PostToolHandler(
      executeTool,
      { enabled: true, ...wiring },
      sourceYielding(1)
    );

    handler.processInBackground('Write', { path: 'a.ts' }, 'body');
    await settle();

    const called = executeTool.mock.calls.map((call) => call[0]);
    expect(called[0]).toBe('memory.search');
    expect(called).toContain('memory.save');
  });

  it('writes at most saveLimit candidates from one result', async () => {
    const handler = new PostToolHandler(
      executeTool,
      { enabled: true, ...wiring, saveLimit: 2 },
      sourceYielding(5)
    );

    handler.processInBackground('Write', { path: 'a.ts' }, 'body');
    await settle();

    const saves = executeTool.mock.calls.filter((call) => call[0] === 'memory.save');
    expect(saves).toHaveLength(2);
  });

  it('keeps running when a tool call throws', async () => {
    executeTool.mockRejectedValue(new Error('synthetic tool failure'));
    const handler = new PostToolHandler(
      executeTool,
      { enabled: true, ...wiring },
      sourceYielding(1)
    );

    expect(() => handler.processInBackground('Write', { path: 'a.ts' }, 'body')).not.toThrow();
    await settle();
  });
});
