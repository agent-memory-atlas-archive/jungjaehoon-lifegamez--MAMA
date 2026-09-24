/**
 * MCP Tool: recall_decision
 *
 * Story M1.3: MCP Tool - recall_decision (ported from mcp-server)
 * Priority: P1 (Core Feature)
 *
 * Recalls decision history for a specific topic using v2 recallMemory API.
 * Supports scope-based filtering.
 *
 * @module recall-decision
 */

/**
 * Create recall decision tool with dependencies
 * @param {Object} deps - Injected dependencies
 * @param {(action: string, input?: Object) => Promise<any>} deps.call -
 *   Shared action-catalog caller
 */
const createRecallDecisionTool = ({ call }) => ({
  name: 'recall_decision',
  description:
    'Recall exact-topic decision history without scopes, or semantic memory matches within supplied scopes. Explicit supersedes links are traversed; reusing a topic does not create a relationship.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          "Decision topic to recall (e.g., 'auth_strategy', 'mesh_detail_choice'). Use the EXACT SAME topic name used in save_decision to see full decision evolution graph.",
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: "Output format. Default: 'markdown'",
      },
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['global', 'user', 'channel', 'project'],
              description: 'Scope type',
            },
            id: {
              type: 'string',
              description: 'Scope identifier (e.g., project path, channel ID)',
            },
          },
          required: ['kind', 'id'],
        },
        description: 'Filter recall results by scope. If omitted, returns all scopes.',
      },
    },
    required: ['topic'],
  },

  async handler(params, _context) {
    const { topic, format = 'markdown', scopes } = params || {};

    try {
      // Validation: Non-empty string check
      if (!topic || typeof topic !== 'string' || topic.trim() === '') {
        return {
          success: false,
          message: '❌ Validation error: Topic must be a non-empty string',
        };
      }

      // One action reads the topic bundle; omitted scopes read the admitted
      // corpus and explicit scopes must be a subset of it (bound server-side).
      const bundle = await call('memory.read:topic', {
        query: topic,
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
      });

      if (format === 'json') {
        return { success: true, history: bundle, message: bundle };
      }

      const memories = bundle?.memories || [];
      if (memories.length === 0) {
        const empty = `❌ No decisions found for topic: ${topic}`;
        return { success: true, history: empty, message: empty };
      }
      let md = `🧠 **Recall: ${topic}** (${memories.length} results)\n\n`;
      for (const [index, m] of memories.entries()) {
        const evolution = memories.length > 1 ? (index === 0 ? ' — latest' : ' — previous') : '';
        md += `### ${m.topic}${evolution}\n`;
        md += `${m.summary}\n`;
        if (m.details && m.details !== m.summary) {
          md += `> ${m.details}\n`;
        }
        md += `- Confidence: ${m.confidence} | Status: ${m.status}`;
        if (m.outcome && m.outcome !== 'pending') {
          md += ` | Outcome: ${m.outcome}`;
        }
        if (m.event_date) {
          md += ` | Event: ${m.event_date}`;
        }
        md += '\n\n';
      }
      return { success: true, history: md, message: md };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        success: false,
        message: `❌ Failed to recall decisions: ${errorMessage}`,
      };
    }
  },
});

module.exports = { createRecallDecisionTool };
