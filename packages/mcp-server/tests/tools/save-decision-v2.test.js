import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createSaveDecisionTool } from '../../src/tools/save-decision.js';
import { MAMAServer } from '../../src/server.js';
import Database from 'better-sqlite3';
import { cleanupTestDB, initTestDB } from '../helpers/test-db.js';
import { createNode } from '@jungjaehoon/mama-core/registry/store';
import { getAdapter, initDB } from '@jungjaehoon/mama-core/db-manager';
import { createActionCall } from '../helpers/action-call.js';

describe('save_decision v2: scopes + event_date', () => {
  let mockCall;
  let tool;

  beforeEach(() => {
    // The tool speaks one protocol: call(action, input) → data payload.
    mockCall = vi.fn().mockImplementation(async (action) => {
      if (action === 'memory.save') {
        return { success: true, saved_decision_id: 'test_id_123', id: 'test_id_123' };
      }
      return {};
    });
    tool = createSaveDecisionTool({ call: mockCall });
  });

  it('passes scopes to memory.save', async () => {
    const scopes = [{ kind: 'project', id: '/my/project' }];
    await tool.handler({
      topic: 'test_topic',
      decision: 'Use scopes',
      reasoning: 'Need isolation',
      scopes,
    });

    expect(mockCall).toHaveBeenCalledWith('memory.save', expect.objectContaining({ scopes }));
  });

  it('maps event_date to the action eventDate field', async () => {
    await tool.handler({
      topic: 'test_topic',
      decision: 'Something happened',
      reasoning: 'On a specific date',
      event_date: '2024-01-15',
    });

    expect(mockCall).toHaveBeenCalledWith(
      'memory.save',
      expect.objectContaining({ eventDate: '2024-01-15' })
    );
  });

  it('works without scopes (backward compat)', async () => {
    await tool.handler({
      topic: 'test_topic',
      decision: 'No scopes',
      reasoning: 'Legacy caller',
    });

    expect(mockCall).toHaveBeenCalledWith(
      'memory.save',
      expect.objectContaining({ topic: 'test_topic' })
    );
    const callInput = mockCall.mock.calls[0][1];
    expect(callInput.scopes).toBeUndefined();
  });

  it('does not forward caller-supplied provenance to memory.save', async () => {
    await tool.handler({
      topic: 'test_topic',
      decision: 'Caller cannot spoof provenance',
      reasoning: 'MCP input is an untrusted public boundary',
      provenance: { envelope_hash: 'attacker_env', gateway_call_id: 'attacker_gw' },
    });

    const callInput = mockCall.mock.calls[0][1];
    expect(callInput.provenance).toBeUndefined();
    expect(callInput.envelope_hash).toBeUndefined();
    expect(callInput.gateway_call_id).toBeUndefined();
  });

  it('scopes appear in inputSchema', () => {
    expect(tool.inputSchema.properties.scopes).toBeDefined();
    expect(tool.inputSchema.properties.scopes.type).toBe('array');
  });

  it('event_date appears in inputSchema', () => {
    expect(tool.inputSchema.properties.event_date).toBeDefined();
    expect(tool.inputSchema.properties.event_date.type).toBe('string');
  });
});

describe('save and save_decision real record identity', () => {
  let dbPath;
  let item;
  let person;
  let saveDecisionTool;

  beforeAll(async () => {
    dbPath = await initTestDB('mcp-save-record-identity');
    await initDB();
    saveDecisionTool = createSaveDecisionTool({ call: createActionCall(getAdapter()) });
    item = createNode(getAdapter(), { kind: 'item', name: 'synthetic item' });
    person = createNode(getAdapter(), { kind: 'person', name: 'synthetic person' });
  });

  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });

  it.each([
    ['save_decision', () => saveDecisionTool.handler],
    [
      'save',
      () => {
        const server = new MAMAServer();
        server.bindRuntime(createActionCall(getAdapter()));
        return server.handleSave.bind(server);
      },
    ],
  ])('persists explicit item and actors through %s', async (_name, handlerFactory) => {
    const result = await handlerFactory()({
      type: _name === 'save' ? 'decision' : 'user_decision',
      topic: `identity-${_name}`,
      decision: 'Keep explicit record identity',
      reasoning: 'The public MCP save surface must forward registry references.',
      item,
      actors: [{ person, role: 'worker' }],
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const id = result.decision_id ?? result.id?.id ?? result.id;
    expect(typeof id).toBe('string');
    const db = new Database(dbPath);
    expect(db.prepare('SELECT item_id FROM decisions WHERE id = ?').get(id)).toEqual({
      item_id: item,
    });
    expect(
      db.prepare('SELECT person_id, role FROM record_actors WHERE record_id = ?').all(id)
    ).toEqual([{ person_id: person, role: 'worker' }]);
    db.close();
  });
});
