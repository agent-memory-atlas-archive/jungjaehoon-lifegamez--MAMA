/**
 * MAMA Memory Tools
 *
 * MCP tool wrappers over the unified action catalog.
 *
 * Every handler is a thin protocol adapter: it validates tool arguments,
 * calls one or more registered actions through the shared runtime client,
 * and shapes the result back into the tool's response contract. This package
 * owns no database handle and no embedding model — the runtime on the other
 * end of the socket does.
 *
 * @module tools
 */

const { createSaveDecisionTool } = require('./save-decision.js');
const { createRecallDecisionTool } = require('./recall-decision.js');
const { createSuggestDecisionTool } = require('./suggest-decision.js');
const { createListDecisionsTool } = require('./list-decisions.js');
const { createUpdateOutcomeTool } = require('./update-outcome.js');
const { createSaveCheckpointTool, createLoadCheckpointTool } = require('./checkpoint-tools.js');
const { createSearchNarrativeTool } = require('./search-narrative.js');
const { createIngestConversationTool } = require('./ingest-conversation.js');
const { createSearchDecisionsAndContractsTool } = require('./search-decisions-and-contracts.js');
const { createCaseTimelineRangeTool } = require('./case-timeline-range.js');

/**
 * Create all MAMA memory tools bound to the shared action caller.
 *
 * @param {Object} deps - Injected dependencies
 * @param {(action: string, input?: Object) => Promise<any>} deps.call -
 *   One call into the action catalog: resolves to the action's data payload
 *   or throws on a confirmed failure / lost response.
 * @returns Object with tool definitions
 */
function createMemoryTools({ call }) {
  const deps = { call };
  return {
    save_decision: createSaveDecisionTool(deps),
    recall_decision: createRecallDecisionTool(deps),
    suggest_decision: createSuggestDecisionTool(deps),
    list_decisions: createListDecisionsTool(deps),
    update_outcome: createUpdateOutcomeTool(deps),
    save_checkpoint: createSaveCheckpointTool(deps),
    load_checkpoint: createLoadCheckpointTool(deps),
    search_narrative: createSearchNarrativeTool(deps),
    ingest_conversation: createIngestConversationTool(deps),
    search_decisions_and_contracts: createSearchDecisionsAndContractsTool(deps),
    case_timeline_range: createCaseTimelineRangeTool(deps),
  };
}

module.exports = {
  createMemoryTools,
};
