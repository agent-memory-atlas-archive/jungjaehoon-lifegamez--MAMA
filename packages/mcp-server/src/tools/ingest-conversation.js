/**
 * MCP Tool: ingest_conversation
 *
 * Ingests conversation messages into MAMA memory as a raw source observation.
 *
 * @module ingest-conversation
 */

/**
 * Create the ingest_conversation tool bound to the shared action caller
 * @param {Object} deps - Injected dependencies
 * @param {(action: string, input?: Object) => Promise<any>} deps.call -
 *   Shared action-catalog caller
 */
const createIngestConversationTool = ({ call }) => ({
  name: 'ingest_conversation',
  description:
    "Ingest a conversation into MAMA's memory. Stores the raw conversation as one source observation without creating decisions. Use this to import past conversations or chat logs into memory.",
  inputSchema: {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: { type: 'string' },
          },
          required: ['role', 'content'],
        },
        description: 'Conversation messages to ingest.',
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
        description: 'Memory scopes for isolation.',
      },
      session_date: {
        type: 'string',
        description: 'ISO 8601 date when the conversation occurred (e.g., "2024-01-15").',
      },
    },
    required: ['messages'],
  },

  async handler(params, _context) {
    const { messages, scopes, session_date, extract } = params || {};

    try {
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return {
          success: false,
          message: '❌ Validation error: messages must be a non-empty array',
        };
      }

      // Extraction was removed from the write boundary: conversations are
      // stored as raw source observations only. Fail before any write so a
      // caller never mistakes a raw observation for an extracted judgment.
      if (extract !== undefined) {
        return {
          success: false,
          message:
            '❌ Validation error: ingest_conversation no longer supports the extract option; ' +
            'conversations are stored as raw source observations without decision writes',
        };
      }

      // One call is one observation: the whole conversation is stored as a
      // single raw evidence record, bound to the operationId the client issued.
      const receipt = await call('source.ingest', {
        messages,
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
        source: {
          connector: 'conversation:mcp_ingest_conversation',
          package: 'mcp-server',
          source_type: 'mcp_ingest_conversation',
        },
        ...(session_date && { session_date }),
      });
      const rawId = receipt?.observationRef ?? receipt?.observationId;

      return {
        success: true,
        raw_id: rawId,
        extracted_memories: [],
        message: `✅ Conversation ingested (ID: ${rawId})`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        success: false,
        message: `❌ Failed to ingest conversation: ${errorMessage}`,
      };
    }
  },
});

module.exports = { createIngestConversationTool };
