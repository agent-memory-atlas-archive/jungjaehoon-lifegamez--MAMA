import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import {
  RegistryError,
  addAlias,
  addAliases,
  createNode,
  listNodes,
  mergeNodes,
  resolveAlias,
  splitNode,
  upsertNode,
} from '../../src/registry/store.js';

/**
 * The registry is the one place that says "these names are the same thing".
 *
 * Alternate spellings cannot join reliably when identity is stored only as a string. A string
 * in a title cannot carry that identity; a node with aliases can.
 *
 * Merging is never automatic here: the caller decides. The store only refuses the shapes
 * that would corrupt the graph (an alias claimed by two nodes, a merge into a dead node).
 */
describe('Story PR3A: registry item and person nodes with aliases', () => {
  let dbPath: string;

  beforeAll(async () => {
    dbPath = await initTestDB('registry-store');
  });
  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });
  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM registry_scope_bindings').run();
    adapter.prepare('DELETE FROM registry_aliases').run();
    adapter.prepare('DELETE FROM registry_nodes').run();
  });

  it('resolves any alias, and its own name, to the same node', () => {
    const id = createNode(getAdapter(), {
      kind: 'item',
      name: 'alpha item',
      aliases: ['a_0001', 'b_0001'],
    });

    expect(resolveAlias(getAdapter(), 'a_0001')?.id).toBe(id);
    expect(resolveAlias(getAdapter(), 'b_0001')?.id).toBe(id);
    expect(resolveAlias(getAdapter(), 'alpha item')?.id).toBe(id);
    expect(resolveAlias(getAdapter(), '  A_0001 ')?.id).toBe(id);
    expect(resolveAlias(getAdapter(), 'unknown thing')).toBeNull();
  });

  it('refuses an alias already claimed by another node instead of guessing', () => {
    createNode(getAdapter(), { kind: 'item', name: 'alpha item', aliases: ['a_0001'] });
    const other = createNode(getAdapter(), { kind: 'item', name: 'beta item' });

    expect(() => addAlias(getAdapter(), other, 'a_0001')).toThrow(RegistryError);
    expect(resolveAlias(getAdapter(), 'a_0001')?.name).toBe('alpha item');
  });

  it('keeps item and person namespaces apart', () => {
    const item = createNode(getAdapter(), { kind: 'item', name: 'shared name' });
    const person = createNode(getAdapter(), { kind: 'person', name: 'shared name' });

    expect(resolveAlias(getAdapter(), 'shared name', 'item')?.id).toBe(item);
    expect(resolveAlias(getAdapter(), 'shared name', 'person')?.id).toBe(person);
  });

  it('merges one node into another, carrying its aliases and leaving a tombstone', () => {
    const survivor = createNode(getAdapter(), {
      kind: 'person',
      name: 'person one',
      aliases: ['P-One'],
    });
    const loser = createNode(getAdapter(), { kind: 'person', name: 'person 1', aliases: ['p1'] });

    mergeNodes(getAdapter(), { loser, survivor, reason: 'owner confirmed same person' });

    expect(resolveAlias(getAdapter(), 'p1')?.id).toBe(survivor);
    expect(resolveAlias(getAdapter(), 'person 1')?.id).toBe(survivor);
    expect(resolveAlias(getAdapter(), 'P-One')?.id).toBe(survivor);
    expect(listNodes(getAdapter(), { kind: 'person' }).map((n) => n.id)).toEqual([survivor]);
  });

  it('splits an item into children that keep the parent reachable', () => {
    const parent = createNode(getAdapter(), {
      kind: 'item',
      name: 'alpha item',
      aliases: ['a_0001'],
    });
    const [first, second] = splitNode(getAdapter(), {
      parent,
      children: [
        { name: 'alpha item / part one', aliases: ['a_0001_p1'] },
        { name: 'alpha item / part two', aliases: ['a_0001_p2'] },
      ],
      reason: 'owner: separate files',
    });

    expect(resolveAlias(getAdapter(), 'a_0001_p1')?.id).toBe(first);
    expect(resolveAlias(getAdapter(), 'a_0001')?.id).toBe(parent);
    expect(listNodes(getAdapter(), { kind: 'item', parentId: parent }).map((n) => n.id)).toEqual([
      first,
      second,
    ]);
  });

  it('never merges by similarity on its own', () => {
    createNode(getAdapter(), { kind: 'person', name: 'person one' });
    const near = createNode(getAdapter(), { kind: 'person', name: 'person 0ne' });

    expect(resolveAlias(getAdapter(), 'person 0ne')?.id).toBe(near);
    expect(listNodes(getAdapter(), { kind: 'person' })).toHaveLength(2);
  });

  it('rolls back node, aliases and scopes when a later alias conflicts', () => {
    createNode(getAdapter(), {
      kind: 'item',
      name: 'existing item',
      aliases: ['taken'],
      scopes: [{ kind: 'project', id: 'project-a' }],
    });
    const before = getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get();
    expect(() =>
      createNode(getAdapter(), {
        kind: 'item',
        name: 'new item',
        aliases: ['free-first', 'taken'],
        scopes: [{ kind: 'project', id: 'project-a' }],
      })
    ).toThrow(/already registered/);
    expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get()).toEqual(
      before
    );
    expect(resolveAlias(getAdapter(), 'free-first')).toBeNull();
  });

  it('rolls back an existing-node alias batch when a later alias conflicts', () => {
    const target = createNode(getAdapter(), { kind: 'item', name: 'target item' });
    createNode(getAdapter(), { kind: 'item', name: 'other item', aliases: ['taken'] });
    expect(() => addAliases(getAdapter(), target, ['free-first', 'taken'])).toThrow(
      /already registered/
    );
    expect(resolveAlias(getAdapter(), 'free-first')).toBeNull();
  });

  it('rolls back parent and earlier children when a later child conflicts', () => {
    createNode(getAdapter(), {
      kind: 'item',
      name: 'existing child',
      aliases: ['taken-child'],
      scopes: [{ kind: 'project', id: 'project-a' }],
    });
    expect(() =>
      upsertNode(getAdapter(), {
        kind: 'item',
        name: 'new parent',
        scopes: [{ kind: 'project', id: 'project-a' }],
        children: [
          { name: 'first child', aliases: ['first-child'] },
          { name: 'second child', aliases: ['taken-child'] },
        ],
      })
    ).toThrow(/already registered/);
    expect(resolveAlias(getAdapter(), 'new parent')).toBeNull();
    expect(resolveAlias(getAdapter(), 'first-child')).toBeNull();
  });

  it('hides a scoped alias and label outside its recorded scope', () => {
    const id = createNode(getAdapter(), {
      kind: 'item',
      name: 'private synthetic item',
      aliases: ['private-synthetic'],
      scopes: [{ kind: 'project', id: 'project-a' }],
    });

    expect(
      resolveAlias(getAdapter(), 'private-synthetic', 'item', [
        { kind: 'project', id: 'project-a' },
      ])?.id
    ).toBe(id);
    expect(
      resolveAlias(getAdapter(), 'private-synthetic', 'item', [
        { kind: 'project', id: 'project-b' },
      ])
    ).toBeNull();
    expect(listNodes(getAdapter(), { scopes: [{ kind: 'project', id: 'project-b' }] })).toEqual([]);
  });

  it('allows the same alias in separate scopes without leaking the hidden node', () => {
    const a = createNode(getAdapter(), {
      kind: 'item',
      name: 'scope a item',
      aliases: ['shared-code'],
      scopes: [{ kind: 'project', id: 'a' }],
    });
    const b = createNode(getAdapter(), {
      kind: 'item',
      name: 'scope b item',
      aliases: ['shared-code'],
      scopes: [{ kind: 'project', id: 'b' }],
    });
    expect(
      resolveAlias(getAdapter(), 'shared-code', 'item', [{ kind: 'project', id: 'a' }])?.id
    ).toBe(a);
    expect(
      resolveAlias(getAdapter(), 'shared-code', 'item', [{ kind: 'project', id: 'b' }])?.id
    ).toBe(b);
    expect(() =>
      resolveAlias(getAdapter(), 'shared-code', 'item', [
        { kind: 'project', id: 'a' },
        { kind: 'project', id: 'b' },
      ])
    ).toThrowError(expect.objectContaining({ code: 'alias_ambiguous' }));
  });

  it('adds an upsert alias only to the admitted scope of a multi-scope node', () => {
    createNode(getAdapter(), {
      kind: 'item',
      name: 'multi scope item',
      scopes: [
        { kind: 'project', id: 'a' },
        { kind: 'project', id: 'b' },
      ],
    });
    upsertNode(getAdapter(), {
      kind: 'item',
      name: 'multi scope item',
      aliases: ['a-only-alias'],
      scopes: [{ kind: 'project', id: 'a' }],
    });
    expect(
      resolveAlias(getAdapter(), 'a-only-alias', 'item', [{ kind: 'project', id: 'a' }])
    ).not.toBeNull();
    expect(
      resolveAlias(getAdapter(), 'a-only-alias', 'item', [{ kind: 'project', id: 'b' }])
    ).toBeNull();
  });

  describe('AC: existing-node upsert is atomic', () => {
    it('rejects children on an existing node without adding aliases or child rows', () => {
      const existing = createNode(getAdapter(), { kind: 'item', name: 'existing parent' });
      expect(() =>
        upsertNode(getAdapter(), {
          kind: 'item',
          name: 'existing parent',
          aliases: ['must-not-stick'],
          children: [{ name: 'child one' }, { name: 'child two' }],
        })
      ).toThrowError(expect.objectContaining({ code: 'existing_children_unsupported' }));
      expect(resolveAlias(getAdapter(), 'must-not-stick')).toBeNull();
      expect(listNodes(getAdapter(), { parentId: existing })).toEqual([]);
    });
  });

  it('propagates loser scopes on merge so a visible alias never reveals a hidden survivor', () => {
    const loser = createNode(getAdapter(), {
      kind: 'item',
      name: 'visible loser',
      scopes: [{ kind: 'project', id: 'a' }],
    });
    const survivor = createNode(getAdapter(), {
      kind: 'item',
      name: 'private survivor',
      scopes: [{ kind: 'project', id: 'b' }],
    });
    mergeNodes(getAdapter(), { loser, survivor, reason: 'explicit merge' });
    expect(
      resolveAlias(getAdapter(), 'visible loser', 'item', [{ kind: 'project', id: 'a' }])?.id
    ).toBe(survivor);
  });

  describe('AC: merged tombstones cannot be reused', () => {
    it('rejects re-merging a tombstoned loser without moving aliases or scopes', () => {
      const loser = createNode(getAdapter(), {
        kind: 'item',
        name: 'merge loser',
        aliases: ['loser-alias'],
        scopes: [{ kind: 'project', id: 'a' }],
      });
      const first = createNode(getAdapter(), { kind: 'item', name: 'first survivor' });
      const second = createNode(getAdapter(), { kind: 'item', name: 'second survivor' });
      mergeNodes(getAdapter(), { loser, survivor: first, reason: 'first merge' });
      expect(() =>
        mergeNodes(getAdapter(), { loser, survivor: second, reason: 'second merge' })
      ).toThrowError(expect.objectContaining({ code: 'loser_merged' }));
      expect(
        resolveAlias(getAdapter(), 'loser-alias', 'item', [{ kind: 'project', id: 'a' }])?.id
      ).toBe(first);
      expect(
        getAdapter()
          .prepare(
            `SELECT COUNT(*) AS count FROM registry_scope_bindings
           WHERE node_id = ? AND scope_kind = 'project' AND scope_id = 'a'`
          )
          .get(second)
      ).toEqual({ count: 0 });
    });
  });
});
