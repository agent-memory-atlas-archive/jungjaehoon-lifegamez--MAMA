import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRecallDecisionTool } from '../../src/tools/recall-decision.js';

const BUNDLE = {
  memories: [
    {
      id: 'mem_1',
      topic: 'auth',
      summary: 'Use JWT',
      details: 'For stateless auth',
      confidence: 0.9,
      status: 'active',
      event_date: '2024-06-15',
    },
  ],
  profile: { static: [], dynamic: [], evidence: [] },
  graph_context: { primary: [], expanded: [], edges: [] },
  search_meta: { query: 'auth', scope_order: ['project'], retrieval_sources: ['vector'] },
};

describe('recall_decision v2: scopes + format', () => {
  let mockCall;
  let tool;

  beforeEach(() => {
    // One protocol: call('memory.read:topic', input) → recall bundle.
    mockCall = vi.fn().mockResolvedValue(BUNDLE);
    tool = createRecallDecisionTool({ call: mockCall });
  });

  // Schema tests
  it('has scopes in inputSchema', () => {
    expect(tool.inputSchema.properties.scopes).toBeDefined();
    expect(tool.inputSchema.properties.scopes.type).toBe('array');
  });

  it('has format in inputSchema', () => {
    expect(tool.inputSchema.properties.format).toBeDefined();
    expect(tool.inputSchema.properties.format.enum).toEqual(['markdown', 'json']);
  });

  it('topic is still required', () => {
    expect(tool.inputSchema.required).toContain('topic');
  });

  // Validation tests
  it('rejects empty topic', async () => {
    const result = await tool.handler({ topic: '' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Validation error');
  });

  it('rejects missing topic', async () => {
    const result = await tool.handler({});
    expect(result.success).toBe(false);
  });

  // Handler behavior: topic recall goes through the unified read surface
  it('calls memory.read:topic with the topic and scopes', async () => {
    const scopes = [{ kind: 'project', id: '/my/project' }];
    const result = await tool.handler({ topic: 'auth', scopes });

    expect(mockCall).toHaveBeenCalledWith('memory.read:topic', {
      query: 'auth',
      scopes,
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('auth');
  });

  it('returns the json bundle when format=json', async () => {
    const scopes = [{ kind: 'project', id: '/p' }];
    const result = await tool.handler({ topic: 'auth', scopes, format: 'json' });

    expect(result.success).toBe(true);
    expect(result.history.memories).toHaveLength(1);
    expect(result.history.memories[0].id).toBe('mem_1');
  });

  it('includes event_date in markdown output', async () => {
    const scopes = [{ kind: 'project', id: '/p' }];
    const result = await tool.handler({ topic: 'auth', scopes });

    expect(result.message).toContain('Event: 2024-06-15');
  });

  // Omitted scopes read the admitted corpus — the server bounds the read,
  // so the adapter never forwards an empty-scope request.
  it('omits scopes from the action input when not provided', async () => {
    const result = await tool.handler({ topic: 'auth' });

    expect(mockCall).toHaveBeenCalledWith('memory.read:topic', { query: 'auth' });
    expect(result.success).toBe(true);
    expect(result.history).toContain('Recall: auth');
  });

  it('omits scopes when the caller passes an empty array', async () => {
    await tool.handler({ topic: 'auth', scopes: [] });

    expect(mockCall).toHaveBeenCalledWith('memory.read:topic', { query: 'auth' });
  });
});
