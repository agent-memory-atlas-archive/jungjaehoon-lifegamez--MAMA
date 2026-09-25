import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCatalog,
  createDispatcher,
  createKnowledge,
  type ActionContext,
} from '@jungjaehoon/mama-core';
import { minimalWorkActionRegistrations } from '../../src/api/work-actions.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const access: ActionContext['access'] = {
  principalId: 'owner-test',
  agentId: 'agent-test',
  actions: ['work.create', 'work.revise'],
  scopes: [{ kind: 'project', id: 'workspace-test' }],
};

describe('minimal work actions', () => {
  it('accepts assignee and roles in create and revise patches', async () => {
    const knowledge = {
      createWork: vi.fn().mockResolvedValue({ commitmentId: 'commitment-test', revision: 1 }),
      reviseWork: vi.fn().mockResolvedValue({ commitmentId: 'commitment-test', revision: 2 }),
    };
    const dispatch = createDispatcher(
      createCatalog(minimalWorkActionRegistrations({ knowledge: knowledge as never }))
    );

    const created = await dispatch(
      {
        action: 'work.create',
        operationId: 'operation-create',
        input: {
          topic: 'work-topic',
          summary: 'work-summary',
          set: {
            title: 'work-title',
            assignee: 'assignee-test',
            roles: [{ role: 'reviewer-test', person: 'person-test' }],
          },
        },
      },
      { access }
    );
    expect(created.status).toBe('completed');
    expect(knowledge.createWork).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'operation-create',
        set: expect.objectContaining({ assignee: 'assignee-test', roles: expect.any(Array) }),
      }),
      access
    );

    const revised = await dispatch(
      {
        action: 'work.revise',
        operationId: 'operation-revise',
        input: {
          commitmentId: 'commitment-test',
          expectedRevision: 1,
          topic: 'work-topic',
          summary: 'clear the assignee after review',
          set: { assignee: null, roles: [] },
        },
      },
      { access }
    );
    expect(revised.status).toBe('completed');
    expect(knowledge.reviseWork).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'operation-revise',
        expectedRevision: 1,
        set: { assignee: null, roles: [] },
      }),
      access
    );
  });

  it('clears an existing field from the read view', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-work-actions-'));
    const handle = await openCoreDatabase({ path: join(root, 'memory.db') });
    try {
      const knowledge = createKnowledge({ adapter: handle.adapter });
      const dispatch = createDispatcher(
        createCatalog(minimalWorkActionRegistrations({ knowledge }))
      );

      const created = await dispatch(
        {
          action: 'work.create',
          operationId: 'operation-create-clear',
          input: {
            topic: 'work-topic',
            summary: 'track the assigned work',
            scopes: access.scopes,
            set: { title: 'assigned work', assignee: 'assignee-test' },
          },
        },
        { access }
      );
      expect(created.status).toBe('completed');
      const commitmentId = (created as { data: { commitmentId: string } }).data.commitmentId;

      const revised = await dispatch(
        {
          action: 'work.revise',
          operationId: 'operation-revise-clear',
          input: {
            commitmentId,
            expectedRevision: 1,
            topic: 'work-topic',
            summary: 'remove the assignee because the assignment ended',
            scopes: access.scopes,
            clear: ['assignee'],
          },
        },
        { access }
      );
      expect(revised.status).toBe('completed');

      const view = knowledge.readWork({ commitmentId }, access).items[0];
      expect(view.values).not.toHaveProperty('assignee');
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires revision history text from the caller', async () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn() };
    const dispatch = createDispatcher(
      createCatalog(minimalWorkActionRegistrations({ knowledge: knowledge as never }))
    );

    const result = await dispatch(
      {
        action: 'work.revise',
        operationId: 'operation-revise-without-history',
        input: {
          commitmentId: 'commitment-test',
          expectedRevision: 1,
          set: { assignee: 'assignee-test' },
        },
      },
      { access }
    );

    expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
    expect(knowledge.reviseWork).not.toHaveBeenCalled();
  });

  it('requires an operation id for durable work commands', async () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn() };
    const dispatch = createDispatcher(
      createCatalog(minimalWorkActionRegistrations({ knowledge: knowledge as never }))
    );
    const result = await dispatch(
      { action: 'work.create', input: { topic: 'topic', summary: 'summary', set: {} } },
      { access }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_COMMAND' } });
    expect(knowledge.createWork).not.toHaveBeenCalled();
  });

  it('rejects a replay work create without source event time before writing', async () => {
    const knowledge = {
      createWork: vi.fn(),
      reviseWork: vi.fn(),
    };
    const dispatch = createDispatcher(
      createCatalog(minimalWorkActionRegistrations({ knowledge: knowledge as never }))
    );

    const result = await dispatch(
      {
        action: 'work.create',
        operationId: 'operation-replay-missing-time',
        input: { topic: 'topic', summary: 'summary', set: { title: 'work' } },
      },
      { access, session: { replaySourceEndMs: 1_000 } }
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'REPLAY_EVENT_TIME_REQUIRED' },
    });
    expect(knowledge.createWork).not.toHaveBeenCalled();
  });

  it('rejects a replay work revise beyond the source ceiling before writing', async () => {
    const knowledge = {
      createWork: vi.fn(),
      reviseWork: vi.fn(),
    };
    const dispatch = createDispatcher(
      createCatalog(minimalWorkActionRegistrations({ knowledge: knowledge as never }))
    );

    const result = await dispatch(
      {
        action: 'work.revise',
        operationId: 'operation-replay-future-time',
        input: {
          commitmentId: 'commitment-test',
          expectedRevision: 1,
          topic: 'topic',
          summary: 'summary',
          eventDatetime: 1_001,
          set: { title: 'work' },
        },
      },
      { access, session: { replaySourceEndMs: 1_000 } }
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'REPLAY_EVENT_TIME_AFTER_CEILING' },
    });
    expect(knowledge.reviseWork).not.toHaveBeenCalled();
  });

  it('describes the owner work contract fields and stable citation handles', () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn() };
    const contracts = minimalWorkActionRegistrations({ knowledge: knowledge as never }).map(
      ({ contract }) => contract
    );
    const create = contracts.find((contract) => contract.name === 'work.create')!;
    const revise = contracts.find((contract) => contract.name === 'work.revise')!;
    const set = create.inputSchema.properties?.set;
    const roles = set?.properties?.roles;
    const role = roles?.oneOf?.find((variant) => variant.type === 'array')?.items;
    const files = set?.properties?.files;
    const file = files?.oneOf?.find((variant) => variant.type === 'array')?.items;

    expect(set?.properties?.stage?.description).toContain('stage');
    expect(set?.properties?.project?.description).toContain('project');
    expect(set?.properties?.lastEventTime?.description).toContain('source event time');
    expect(set?.properties?.files?.description).toContain('locator');
    expect(file?.properties?.hash?.description).toContain('hash');
    expect(role?.properties?.confirmed?.description).toContain('unconfirmed');
    expect(revise.inputSchema.properties?.commitmentId?.description).toContain('stable');
    expect(create.inputSchema.properties?.sourceRefs?.description).toContain('observationRef');
  });
});
