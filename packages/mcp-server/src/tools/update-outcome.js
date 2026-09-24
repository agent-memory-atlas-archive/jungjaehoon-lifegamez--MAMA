/**
 * MCP Tool: update_outcome
 *
 * Story M1.5: MCP Tool - update_outcome (deferred from M1.3)
 * Priority: P1 (Core Feature)
 *
 * Updates decision outcomes based on real-world results.
 * Enables tracking success/failure of decisions over time.
 *
 * @module update-outcome
 */

/**
 * Valid outcome values (uppercase canonical form)
 */
const VALID_OUTCOMES = ['SUCCESS', 'FAILED', 'PARTIAL'];

/**
 * Suggest the closest valid outcome for typos/case errors
 * @param {string} input - User's input
 * @returns {string} Suggested outcome
 */
function suggestOutcome(input) {
  if (!input || typeof input !== 'string') {
    return 'SUCCESS';
  }

  const normalized = input.toUpperCase().trim();

  // Exact match after normalization
  if (VALID_OUTCOMES.includes(normalized)) {
    return normalized;
  }

  // Prefix matching (e.g., "suc" -> "SUCCESS", "fail" -> "FAILED")
  const prefixMatch = VALID_OUTCOMES.find((o) => o.startsWith(normalized.slice(0, 3)));
  if (prefixMatch) {
    return prefixMatch;
  }

  // Common typos/variations
  const typoMap = {
    SUCCEED: 'SUCCESS',
    SUCCEEDED: 'SUCCESS',
    PASS: 'SUCCESS',
    PASSED: 'SUCCESS',
    OK: 'SUCCESS',
    FAIL: 'FAILED',
    FAILURE: 'FAILED',
    ERROR: 'FAILED',
    PART: 'PARTIAL',
    PARTIALLY: 'PARTIAL',
  };

  return typoMap[normalized] || 'SUCCESS';
}

/**
 * Create the update_outcome tool bound to the shared action caller
 * @param {Object} deps - Injected dependencies
 * @param {(action: string, input?: Object) => Promise<any>} deps.call -
 *   Shared action-catalog caller
 */
const createUpdateOutcomeTool = ({ call }) => ({
  name: 'update_outcome',
  description: `Update decision outcome after real-world validation.

**WHEN TO USE:**
• Days/weeks later when issues are discovered → mark FAILED with reason
• After production deployment confirms success → mark SUCCESS
• After partial success with known limitations → mark PARTIAL with limitation

**WHY IMPORTANT:**
Tracks decision evolution - failure outcomes help future LLMs avoid same mistakes.
TIP: If decision failed, save a new decision with same topic to supersede it.

**OUTCOME TYPES (case-insensitive):**
• SUCCESS / success: Decision worked as expected
• FAILED / failed: Decision caused problems (provide failure_reason)
• PARTIAL / partial: Decision partially worked (provide limitation)

**EVIDENCE TYPES:**
When providing failure_reason or limitation, consider including:
• url: Link to documentation, PR, or external resource
• file_path: Path to relevant code file
• log_snippet: Relevant log output or error message
• observation: Direct observation or user feedback
• reasoning_ref: Reference to another decision's reasoning`,
  inputSchema: {
    type: 'object',
    properties: {
      decisionId: {
        type: 'string',
        description:
          "Decision ID to update (e.g., 'decision_auth_strategy_123456_abc'). Get this from recall_decision or list_decisions responses.",
      },
      outcome: {
        type: 'string',
        description:
          "Outcome status (case-insensitive):\n• 'SUCCESS' / 'success': Decision worked well in practice\n• 'FAILED' / 'failed': Decision caused problems (explain in failure_reason)\n• 'PARTIAL' / 'partial': Decision partially worked (explain in limitation)",
      },
      failure_reason: {
        type: 'string',
        description:
          "Why the decision failed (REQUIRED if outcome='FAILED'). Examples: 'Performance degraded under load', 'Security vulnerability found', 'User complaints about complexity'. Max 2000 characters.",
      },
      limitation: {
        type: 'string',
        description:
          "What limitations were discovered (OPTIONAL for outcome='PARTIAL'). Examples: 'Works for most cases but fails with large datasets', 'Acceptable for MVP but needs optimization'. Max 2000 characters.",
      },
    },
    required: ['decisionId', 'outcome'],
  },

  async handler(params, _context) {
    const { decisionId, outcome, failure_reason, limitation } = params || {};

    try {
      // Validation: Required fields
      if (!decisionId || typeof decisionId !== 'string' || decisionId.trim() === '') {
        return {
          success: false,
          message:
            '❌ Validation error: decisionId must be a non-empty string\n' +
            '   💡 Use search tool to find valid decision IDs.',
        };
      }

      // Story 3.1: Case-insensitive outcome normalization
      const normalizedOutcome =
        outcome && typeof outcome === 'string' ? outcome.toUpperCase().trim() : outcome;

      if (!normalizedOutcome || !VALID_OUTCOMES.includes(normalizedOutcome)) {
        const suggestion = suggestOutcome(outcome);
        return {
          success: false,
          message:
            '❌ Validation error: outcome must be "SUCCESS", "FAILED", or "PARTIAL"\n' +
            `   💡 Did you mean "${suggestion}"? (case-insensitive, e.g., "success" works too)`,
        };
      }

      // Validation: failure_reason required for FAILED
      if (normalizedOutcome === 'FAILED' && (!failure_reason || failure_reason.trim() === '')) {
        return {
          success: false,
          message:
            '❌ Validation error: failure_reason is required when outcome="FAILED"\n' +
            '   💡 Explain what went wrong so future agents can learn from this.',
        };
      }

      // Validation: Field lengths
      if (failure_reason && failure_reason.length > 2000) {
        return {
          success: false,
          message: `❌ Validation error: failure_reason must be ≤ 2000 characters (got ${failure_reason.length})`,
        };
      }

      if (limitation && limitation.length > 2000) {
        return {
          success: false,
          message: `❌ Validation error: limitation must be ≤ 2000 characters (got ${limitation.length})`,
        };
      }

      // The amendment is one action call — the append-only judgment row and
      // the maintained projection move in one transaction server-side.
      await call('memory.update', {
        id: decisionId,
        outcome: normalizedOutcome,
        ...(failure_reason !== undefined && { failure_reason }),
        ...(limitation !== undefined && { limitation }),
      });

      // Return success response
      return {
        success: true,
        decision_id: decisionId,
        outcome: normalizedOutcome,
        message: `✅ Decision outcome updated to ${normalizedOutcome}${
          failure_reason
            ? `\n   Reason: ${failure_reason.substring(0, 100)}${failure_reason.length > 100 ? '...' : ''}`
            : ''
        }${limitation ? `\n   Limitation: ${limitation.substring(0, 100)}${limitation.length > 100 ? '...' : ''}` : ''}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      // Check for common errors
      if (errorMessage.includes('not found')) {
        return {
          success: false,
          message: `❌ Decision not found: ${decisionId}\n\nUse recall_decision or list_decisions to find valid decision IDs.`,
        };
      }

      return {
        success: false,
        message: `❌ Failed to update outcome: ${errorMessage}`,
      };
    }
  },
});
module.exports = { createUpdateOutcomeTool };
