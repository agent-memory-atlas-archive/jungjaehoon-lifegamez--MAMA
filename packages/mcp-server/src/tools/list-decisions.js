/**
 * MCP Tool: list_decisions
 *
 * Lists recent decisions in chronological order.
 * Returns formatted list with time, type, topic, preview, confidence, and status.
 *
 * Flow:
 * 1. User (via Claude Desktop): "Show me recent decisions"
 * 2. Claude: Calls list_decisions MCP tool
 * 3. Tool: Validates input, calls mama.list()
 * 4. mama.list(): Queries recent decisions + formats as markdown
 * 5. Tool: Returns formatted markdown response
 *
 * @module list-decisions
 */

/**
 * Create the list_decisions tool bound to the shared action caller
 * @param {Object} deps - Injected dependencies
 * @param {(action: string, input?: Object) => Promise<any>} deps.call -
 *   Shared action-catalog caller
 */
const createListDecisionsTool = ({ call }) => ({
  name: 'list_decisions',
  description:
    'List recent decisions in chronological order. Returns formatted list showing time, type (user/assistant), topic, preview, confidence, and status. Use this to see recent activity or find decisions by browsing. Use scopes to filter by project/channel.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of decisions to return (default: 20, max: 100)',
        minimum: 1,
        maximum: 100,
      },
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        description: 'Filter list by scope. If omitted, lists all scopes.',
      },
    },
    required: [],
  },

  async handler(params, _context) {
    const { limit = 20, scopes } = params || {};

    try {
      // Validation: Limit range check
      if (limit < 1 || limit > 100) {
        return {
          success: false,
          message: '❌ Validation error: Limit must be between 1 and 100',
        };
      }

      // A query-less memory.search is the recent-decisions ledger read.
      const result = await call('memory.search', {
        limit,
        ...(scopes && { scopes }),
      });
      const items = Array.isArray(result?.results) ? result.results : [];

      const list =
        items.length === 0
          ? 'No decisions recorded yet.'
          : `Recent decisions (${items.length}):\n` +
            items
              .map((d, index) => {
                const when = d.created_at ? new Date(d.created_at).toISOString() : '';
                const status = d.status ? ` [${d.status}]` : '';
                const confidence =
                  typeof d.confidence === 'number' ? ` ${Math.round(d.confidence * 100)}%` : '';
                return `${index + 1}. **${d.topic || d.id}**${confidence}${status} ${when}\n   ${d.decision || d.summary || ''}`;
              })
              .join('\n');

      // Return success response with formatted list
      return {
        success: true,
        list,
        message: list, // For backward compatibility with MCP response format
      };
    } catch (error) {
      // Error handling: Return user-friendly message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      return {
        success: false,
        message: `❌ Failed to list decisions: ${errorMessage}`,
      };
    }
  },
});
module.exports = { createListDecisionsTool };
