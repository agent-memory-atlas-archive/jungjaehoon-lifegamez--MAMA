/**
 * MCP Tool: search_decisions_and_contracts
 *
 * PreToolUse hook RPC — searches decisions and contract-specific memories
 * for file-aware context injection before Edit/Write/apply_patch tool calls.
 *
 * @module search-decisions-and-contracts
 */

const path = require('path');

/**
 * Create the search_decisions_and_contracts tool bound to the shared action caller
 * @param {Object} deps - Injected dependencies
 * @param {(action: string, input?: Object) => Promise<any>} deps.call -
 *   Shared action-catalog caller
 */
const createSearchDecisionsAndContractsTool = ({ call }) => ({
  name: 'search_decisions_and_contracts',
  description: 'Search decisions and contracts for PreToolUse hook injection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for decisions.' },
      filePath: { type: 'string', description: 'File path context.' },
      toolName: { type: 'string', description: 'Tool name (Edit/Write/apply_patch).' },
      decisionLimit: { type: 'number', description: 'Max decisions (default: 5).' },
      contractLimit: { type: 'number', description: 'Max contracts (default: 3).' },
      similarityThreshold: {
        type: 'number',
        description: 'Similarity threshold (default: 0.7).',
      },
    },
  },

  async handler(args = {}) {
    try {
      const {
        query = '',
        filePath = '',
        toolName = '',
        decisionLimit = 5,
        contractLimit = 3,
        similarityThreshold = 0.7,
      } = args;

      let decisionResults = [];
      let contractResults = [];

      // Decision search. A failure here is not an empty result: it reaches the
      // outer catch and the caller gets success:false, which is the only way it
      // can tell "nothing matched" from "the search did not run".
      if (decisionLimit > 0 && query) {
        const result = await call('memory.search', {
          query,
          limit: decisionLimit,
          threshold: similarityThreshold,
        });
        const results = Array.isArray(result?.results) ? result.results : [];
        decisionResults = results.slice(0, decisionLimit);
      }

      // Contract search (file-specific)
      const contractTools = ['Edit', 'Write', 'apply_patch'];
      const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java'];
      const ext = filePath ? path.extname(filePath) : '';

      if (
        contractLimit > 0 &&
        filePath &&
        contractTools.includes(toolName) &&
        codeExtensions.includes(ext)
      ) {
        const basename = path.basename(filePath, ext);
        const keywords = basename.split(/[-_]/).filter(Boolean);
        const contractQuery = `contract api ${keywords.join(' ')}`.trim();

        if (contractQuery) {
          const contractResult = await call('memory.search', {
            query: contractQuery,
            limit: contractLimit,
            threshold: similarityThreshold,
            topicPrefix: 'contract_',
          });
          contractResults = Array.isArray(contractResult?.results) ? contractResult.results : [];
        }
      }

      return {
        success: true,
        decisionResults,
        contractResults,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

module.exports = { createSearchDecisionsAndContractsTool };
