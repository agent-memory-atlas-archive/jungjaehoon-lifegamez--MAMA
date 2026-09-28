import { describe, expect, it } from 'vitest';
import type { ActionContract } from '@jungjaehoon/mama-core';
import { actionCatalogLine, helpActionRegistrations } from '../../src/api/help-actions.js';

const contracts = [
  {
    name: 'work.list',
    summary: 'Read owner work progressively. Views: overview, pipeline, items, detail.',
    inputSchema: { type: 'object', properties: { view: { type: 'string' } } },
    examples: [{ title: 'Pipeline', input: { view: 'pipeline' } }],
  },
  {
    name: 'memory.read:provenance',
    summary: 'Trace a memory to its cited source messages.',
    inputSchema: { type: 'object' },
  },
] as unknown as ActionContract[];

const help = helpActionRegistrations({ contracts: () => contracts })[0]!;
const run = (input: unknown) => help.exec(input as never, {} as never) as Record<string, unknown>;

describe('help action', () => {
  it('lists every action with its first sentence when no names are given', () => {
    expect(run({})).toEqual({
      actions: [
        { name: 'work.list', summary: 'Read owner work progressively.' },
        { name: 'memory.read:provenance', summary: 'Trace a memory to its cited source messages.' },
      ],
    });
    expect(actionCatalogLine('x'.repeat(300))).toHaveLength(160);
  });

  it('returns the full contract for dotted, Codex and Claude names alike', () => {
    for (const name of ['work.list', 'work_list', 'mcp__mama__work_list']) {
      const [contract] = (run({ actions: [name] }) as { actions: Array<Record<string, unknown>> })
        .actions;
      expect(contract).toMatchObject({
        name: 'work.list',
        inputSchema: contracts[0]!.inputSchema,
        examples: contracts[0]!.examples,
      });
    }
    expect(
      (run({ actions: ['mcp__mama__memory_read_provenance'] }) as { actions: unknown[] }).actions
    ).toHaveLength(1);
    expect(() => run({ actions: ['work.delete'] })).toThrow(/unknown actions: work.delete/);
  });
});
