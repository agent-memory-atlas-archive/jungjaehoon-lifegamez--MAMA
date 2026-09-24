/**
 * MCP Tool: case_timeline_range
 *
 * Thin MCP wrapper over the unified graph timeline view — a case seed read
 * through graph.query applies the caller's current authority before any ref
 * is resolved.
 *
 * @module case-timeline-range
 */

/**
 * Create the case_timeline_range tool bound to the shared action caller
 * @param {Object} deps - Injected dependencies
 * @param {(action: string, input?: Object) => Promise<any>} deps.call -
 *   Shared action-catalog caller
 */
const createCaseTimelineRangeTool = ({ call }) => ({
  name: 'case_timeline_range',
  description:
    'Return a bounded, chronological timeline for a case. Includes decision, event, observation, and artifact memberships resolved through canonical case chains.',
  inputSchema: {
    type: 'object',
    properties: {
      case_id: {
        type: 'string',
        description: 'Case UUID to read. Merged cases resolve through their canonical case chain.',
      },
      from: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: 'Optional inclusive lower date bound. ISO 8601 string or epoch milliseconds.',
      },
      to: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: 'Optional inclusive upper date bound. ISO 8601 string or epoch milliseconds.',
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: "Timeline order. Default: 'asc'.",
      },
      limit: {
        type: 'number',
        minimum: 0,
        maximum: 500,
        description: 'Maximum items to return. Default: 100. Maximum: 500.',
      },
      include_connector_enrichments: {
        type: 'boolean',
        description: 'Include connector event snapshots for observations/artifacts when available.',
      },
    },
    required: ['case_id'],
  },

  async handler(args) {
    const input = args || {};
    const toMs = (value) => {
      if (value === undefined || value === null) {
        return undefined;
      }
      const ms = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(ms)) {
        throw new Error(`case_timeline_range bound is not a parseable date: ${value}`);
      }
      return ms;
    };
    const start = toMs(input.from);
    const end = toMs(input.to);

    // The designed timeline read is the graph view over the case seed —
    // identity chains and current authority resolve server-side.
    const page = await call('graph.query', {
      view: 'timeline',
      seeds: [{ kind: 'case', id: input.case_id }],
      history: 'all',
      ...(input.limit !== undefined && { limit: Math.max(1, Math.min(500, input.limit)) }),
      ...(start !== undefined || end !== undefined
        ? {
            eventRange: {
              ...(start !== undefined && { start }),
              ...(end !== undefined && { end }),
            },
          }
        : {}),
    });

    // The graph page carries timeline entries as hydrated nodes plus the
    // edges between them; both arrive in event order from the server. The
    // seed node's resolvedRef is the canonical fold: a merged case reports
    // the terminal case it now stands for.
    const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
    const edges = Array.isArray(page?.edges) ? page.edges : [];
    const seedNode = nodes.find(
      (node) => node?.ref?.kind === 'case' && node.ref.id === input.case_id
    );
    const terminalId =
      seedNode?.resolvedRef?.kind === 'case' ? seedNode.resolvedRef.id : input.case_id;

    return {
      case_id: input.case_id,
      terminal_case_id: terminalId,
      resolved_via_case_id: terminalId === input.case_id ? null : input.case_id,
      items: input.order === 'desc' ? [...nodes].reverse() : nodes,
      edges: input.order === 'desc' ? [...edges].reverse() : edges,
      coverage: page?.coverage ?? null,
      snapshot: page?.snapshot ?? null,
      next_cursor: page?.nextCursor ?? null,
    };
  },
});

module.exports = { createCaseTimelineRangeTool };
