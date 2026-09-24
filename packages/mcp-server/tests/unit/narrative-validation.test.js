import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSaveDecisionTool } from '../../src/tools/save-decision.js';

/**
 * Narrative input validation over the action contract.
 *
 * The unified memory.save payload carries topic/kind/summary/details/
 * confidence — the legacy evidence/alternatives/risks/trust_context fields
 * were accepted by api.save but never persisted, so the adapter must not
 * forward them.
 */
describe('Narrative Input Validation', () => {
  let saveDecisionTool;
  let mockCall;

  beforeEach(() => {
    vi.clearAllMocks();

    mockCall = vi.fn().mockImplementation(async (action) => {
      if (action === 'memory.save') {
        return { success: true, saved_decision_id: 'decision_123', id: 'decision_123' };
      }
      if (action === 'memory.read:topic') {
        return { memories: [] };
      }
      return {};
    });

    saveDecisionTool = createSaveDecisionTool({ call: mockCall });
  });

  describe('save_decision tool', () => {
    it('maps narrative fields onto the memory.save contract', async () => {
      const params = {
        topic: 'test_topic',
        decision: 'test_decision',
        reasoning: 'test_reasoning',
        // Legacy fields the action contract deliberately does not carry.
        evidence: ['file.js', 'log.txt'],
        alternatives: ['alt1', 'alt2'],
        risks: 'high risk',
      };

      const result = await saveDecisionTool.handler(params);

      if (!result.success) {
        console.error('Test failed result:', result);
      }

      expect(result.success).toBe(true);
      expect(mockCall).toHaveBeenCalledWith(
        'memory.save',
        expect.objectContaining({
          topic: 'test_topic',
          kind: 'decision',
          summary: 'test_decision',
          details: 'test_reasoning',
        })
      );
      const input = mockCall.mock.calls.find(([action]) => action === 'memory.save')[1];
      expect(input.evidence).toBeUndefined();
      expect(input.alternatives).toBeUndefined();
      expect(input.risks).toBeUndefined();
      expect(input.trust_context).toBeUndefined();
    });

    it('should handle missing optional narrative fields', async () => {
      const params = {
        topic: 'test_topic',
        decision: 'test_decision',
        reasoning: 'test_reasoning',
      };

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(true);
      const input = mockCall.mock.calls.find(([action]) => action === 'memory.save')[1];
      expect(input.evidence).toBeUndefined();
      expect(input.alternatives).toBeUndefined();
      expect(input.risks).toBeUndefined();
    });

    it('should fail if required fields are missing', async () => {
      const params = {
        topic: 'test_topic',
        decision: 'test_decision',
        // reasoning missing
      };

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Validation error');
    });

    it('should reject malformed contract decisions', async () => {
      const params = {
        topic: 'contract_get_users',
        decision: 'Add endpoint',
        reasoning: 'Needs to be added',
      };

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(false);
      expect(result.message).toContain('contract decision seems malformed');
      expect(mockCall).not.toHaveBeenCalledWith('memory.save', expect.anything());
    });

    it('should accept well-formed contract decisions', async () => {
      const params = {
        topic: 'contract_get_users',
        decision: 'GET /users expects none, returns User[] defined in users.ts',
        reasoning: 'Represents API contract from users.ts and must be stable.',
      };

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(true);
      const input = mockCall.mock.calls.find(([action]) => action === 'memory.save')[1];
      expect(input.topic).toBe('contract_get_users');
      expect(input.summary).toBe('GET /users expects none, returns User[] defined in users.ts');
      expect(input.trust_context).toBeUndefined();
    });

    it('should skip duplicate contract decisions', async () => {
      const params = {
        topic: 'contract_get_users',
        decision: 'GET /users expects none, returns User[] defined in users.ts',
        reasoning: 'Same as existing contract.',
      };

      mockCall.mockImplementation(async (action) => {
        if (action === 'memory.read:topic') {
          return {
            memories: [
              {
                id: 'decision_existing',
                topic: 'contract_get_users',
                decision: 'GET /users expects none, returns User[] defined in users.ts',
                status: 'active',
              },
            ],
          };
        }
        return {};
      });

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(true);
      expect(result.decision_id).toBe('decision_existing');
      expect(result.message).toContain('Duplicate contract');
      expect(mockCall).not.toHaveBeenCalledWith('memory.save', expect.anything());
    });
  });
});
