import { describe, expect, it, vi } from 'vitest';
import { createIngestConversationTool } from '../../src/tools/ingest-conversation.js';

describe('ingest_conversation provenance boundary', () => {
  it('does not forward caller-supplied provenance to source.ingest', async () => {
    const call = vi.fn().mockResolvedValue({
      observationRef: 'raw_1',
    });
    const tool = createIngestConversationTool({ call });

    const result = await tool.handler({
      messages: [{ role: 'user', content: 'Remember this safely.' }],
      scopes: [{ kind: 'project', id: '/repo' }],
      provenance: { envelope_hash: 'attacker_env', gateway_call_id: 'attacker_gw' },
    });

    expect(result).toMatchObject({ success: true, raw_id: 'raw_1' });
    expect(call).toHaveBeenCalledWith('source.ingest', expect.any(Object));
    const [, input] = call.mock.calls[0];
    expect(input.provenance).toBeUndefined();
    expect(input.envelope_hash).toBeUndefined();
    expect(input.gateway_call_id).toBeUndefined();
  });
});
