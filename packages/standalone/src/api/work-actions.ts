import type { ActionContext, ActionRegistration, ActionSchemaObject } from '@jungjaehoon/mama-core';
import { recordLinkSchema, scopeRefSchema } from '@jungjaehoon/mama-core/api/catalog';
import {
  JudgmentError,
  type CreateWorkCommand,
  type Knowledge,
  type OwnerWorkPatch,
  type ReviseWorkCommand,
} from '@jungjaehoon/mama-core/knowledge';

export interface WorkPorts {
  knowledge: Pick<Knowledge, 'createWork' | 'reviseWork'>;
}

const nullableText: ActionSchemaObject = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
};

const workPatchSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: nullableText,
    description: nullableText,
    status: nullableText,
    priority: nullableText,
    dueAt: nullableText,
    deadline: nullableText,
    deadlineOffsetMinutes: {
      oneOf: [{ type: 'integer', minimum: -840, maximum: 840 }, { type: 'null' }],
    },
    completionCriteria: { type: 'string', pattern: '\\S' },
    assignee: nullableText,
    assigneeText: nullableText,
    latestEvent: nullableText,
    confirmed: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
    roles: { oneOf: [{ type: 'array', items: {} }, { type: 'null' }] },
    data: { oneOf: [{ type: 'object' }, { type: 'null' }] },
  },
};

const commandFields: Record<string, ActionSchemaObject> = {
  topic: { type: 'string', minLength: 1 },
  summary: { type: 'string', minLength: 1 },
  reasoning: { type: 'string', minLength: 1 },
  scopes: { type: 'array', items: scopeRefSchema },
  sourceRefs: { type: 'array', items: { type: 'string', minLength: 1 } },
  links: { type: 'array', items: recordLinkSchema },
  eventDatetime: { oneOf: [{ type: 'number' }, { type: 'null' }] },
  recordedAt: { type: 'number' },
  event: { type: 'object' },
};

const createSchema: ActionSchemaObject = {
  type: 'object',
  required: ['topic', 'summary', 'set'],
  additionalProperties: false,
  properties: { ...commandFields, set: workPatchSchema },
};

const reviseSchema: ActionSchemaObject = {
  type: 'object',
  required: ['commitmentId', 'expectedRevision', 'topic', 'summary'],
  additionalProperties: false,
  properties: {
    ...commandFields,
    commitmentId: { type: 'string', minLength: 1 },
    expectedRevision: { type: 'integer', minimum: 0 },
    set: workPatchSchema,
    clear: { type: 'array', items: { type: 'string' } },
  },
};

function operationId(context: ActionContext, action: string): string {
  if (typeof context.operationId !== 'string' || context.operationId.trim() === '') {
    throw new JudgmentError('INVALID_COMMAND', `${action} requires operationId`);
  }
  return context.operationId;
}

function commandFieldsFrom(body: Record<string, unknown>): Record<string, unknown> {
  const { commitmentId: _commitmentId, expectedRevision: _expectedRevision, ...fields } = body;
  return fields;
}

export function minimalWorkActionRegistrations(ports: WorkPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'work.create',
        recallableWrite: true,
        summary:
          'Create one owner-work commitment. Product fields such as assignee and roles remain part of the revision patch.',
        inputSchema: createSchema,
        examples: [
          {
            title: 'Create owner work',
            input: {
              topic: 'work topic',
              summary: 'what the work means',
              set: { title: 'work title', assignee: 'assignee', roles: [] },
            },
          },
        ],
      },
      exec: (input, context) => {
        const body = input as Record<string, unknown>;
        return ports.knowledge.createWork(
          {
            ...body,
            ...commandFieldsFrom(body),
            commandId: operationId(context, 'work.create'),
            modelRunId: context.session?.modelRunId,
          } as unknown as CreateWorkCommand,
          context.access
        );
      },
    },
    {
      contract: {
        name: 'work.revise',
        recallableWrite: true,
        summary:
          'Revise owner work at an expected revision. The required summary states what changed and why, in one or two sentences. Compare-and-set prevents overwriting a revision the caller did not read.',
        inputSchema: reviseSchema,
        examples: [
          {
            title: 'Revise assignee and roles',
            input: {
              commitmentId: 'commitment-reference',
              expectedRevision: 1,
              topic: 'work topic',
              summary: 'what changed and why',
              set: { assignee: null, roles: [] },
            },
          },
        ],
      },
      exec: (input, context) => {
        const body = input as Record<string, unknown>;
        const commitmentId = body.commitmentId;
        return ports.knowledge.reviseWork(
          {
            ...commandFieldsFrom(body),
            commitmentId,
            expectedRevision: body.expectedRevision,
            commandId: operationId(context, 'work.revise'),
            modelRunId: context.session?.modelRunId,
          } as unknown as ReviseWorkCommand,
          context.access
        );
      },
    },
  ];
}

export type { OwnerWorkPatch };
