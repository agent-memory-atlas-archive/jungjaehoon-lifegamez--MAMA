/**
 * The recall bundle's scrub and its safe field projection.
 *
 * Both lived in a standalone tool case that wrapped memory.read:topic, so a
 * caller naming the action got unredacted full records while
 * memory.read:provenance scrubbed its excerpts. They are core's now and the
 * action applies them; these are the claims that came with them.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeRecallBundle } from '../../src/memory/recall-sanitize.js';

const record = (id: string, topic: string, summary: string) => ({ id, topic, summary });

describe('sanitizeRecallBundle', () => {
  it('keeps a handle on every branch, not just memories', () => {
    // Without a handle the agent reads memories it cannot point at: it can
    // never say WHICH memory a statement rests on, so a claim has no traceable
    // evidence and an owner correction has no address. The id is opaque, so
    // returning it discloses nothing the summary already does not.
    //
    // Profile and graph records go through the same scrub by a different
    // route, so a future transformation could drop identifiers there while
    // `memories` keeps them and nothing would notice.
    const bundle = sanitizeRecallBundle({
      profile: {
        static: [record('mem_static', 'profile/static', 'static detail')],
        dynamic: [record('mem_dynamic', 'profile/dynamic', 'dynamic detail')],
        evidence: [{ topic: 'profile/evidence' }],
      },
      memories: [record('mem_main', 'memories/main', 'main detail')],
      graph_context: {
        primary: [record('mem_primary', 'graph/primary', 'primary detail')],
        expanded: [record('mem_expanded', 'graph/expanded', 'expanded detail')],
        edges: [{ from: 'a', to: 'b' }],
      },
      search_meta: { query: 'coverage' },
    });

    expect(bundle.profile.static[0]?.memoryId).toBe('mem_static');
    expect(bundle.profile.dynamic[0]?.memoryId).toBe('mem_dynamic');
    expect(bundle.memories[0]?.memoryId).toBe('mem_main');
    expect(bundle.graph_context.primary[0]?.memoryId).toBe('mem_primary');
    expect(bundle.graph_context.expanded[0]?.memoryId).toBe('mem_expanded');
    expect(bundle.profile.evidence[0]?.topic).toBe('profile/evidence');
    // Edges are counted, never returned: the count says how connected a record
    // is without handing back the other ends.
    expect(bundle.graph_context.edge_count).toBe(1);
  });

  it('narrows a record to the fields a read may answer with', () => {
    const bundle = sanitizeRecallBundle({
      memories: [
        {
          id: 'mem_1',
          topic: 'a topic',
          kind: 'decision',
          summary: 'a summary',
          confidence: 0.7,
          status: 'active',
          details: 'the long reasoning body a read must not hand back',
          reasoning: 'nor this',
        },
      ],
    });

    expect(Object.keys(bundle.memories[0] ?? {}).sort()).toEqual(
      ['confidence', 'kind', 'memoryId', 'status', 'summary', 'topic'].sort()
    );
  });

  it('keeps the outcome a reader renders', () => {
    // The projection was written for one consumer and then became the action's
    // answer for all of them. Dropping `outcome` made a recall present a failed
    // decision as if it still held - caught by the MCP server's own recall
    // rendering, not by anything here, which is why it is pinned here now.
    const bundle = sanitizeRecallBundle({
      memories: [{ id: 'mem_1', topic: 'deploy', summary: 'a summary', outcome: 'FAILED' }],
    });

    expect(bundle.memories[0]?.outcome).toBe('FAILED');
  });

  it('redacts secret-shaped material inside the text it keeps', () => {
    // A URL and an address, not a key-shaped literal: the scrub covers both,
    // and a key-shaped fixture is the thing the repo's own PII guard exists to
    // keep out of source - correctly, since it cannot tell a test's from a
    // real one.
    const bundle = sanitizeRecallBundle({
      memories: [
        {
          id: 'mem_secret',
          topic: 'deploy',
          summary: 'reachable at https://host.invalid/path and owner@host.invalid',
        },
      ],
    });

    const summary = bundle.memories[0]?.summary ?? '';
    expect(summary).not.toContain('https://host.invalid/path');
    expect(summary).not.toContain('owner@host.invalid');
    expect(summary).toContain('[redacted]');
  });

  it('answers the empty bundle for anything that is not one', () => {
    for (const input of [undefined, null, 'a string', 42, []]) {
      const bundle = sanitizeRecallBundle(input);
      expect(bundle.memories).toEqual([]);
      expect(bundle.profile.static).toEqual([]);
      expect(bundle.graph_context.edge_count).toBe(0);
    }
  });
});
