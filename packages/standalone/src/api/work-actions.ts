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
  description: 'Optional text value; null clears the field, e.g. "reviewed" or null.',
  oneOf: [{ type: 'string' }, { type: 'null' }],
};

const workFileSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    locator: { type: 'string', minLength: 1, description: 'Relevant file locator.' },
    version: { type: 'string', minLength: 1, description: 'Relevant file version.' },
    hash: { type: 'string', minLength: 1, description: 'Relevant file content hash.' },
  },
  required: ['locator', 'version', 'hash'],
};

const workRoleSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    personRef: { type: 'string', minLength: 1, description: 'Person reference for the role.' },
    role: { type: 'string', minLength: 1, description: 'Role judged from evidence.' },
    evidenceRefs: {
      type: 'array',
      description: 'Stable observationRef handles supporting the role.',
      items: { type: 'string', minLength: 1 },
    },
    confirmed: {
      type: 'boolean',
      description:
        'True when evidence confirms the role; false is the explicit unconfirmed status.',
    },
  },
};

const workPatchSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { ...nullableText, description: 'Work title, e.g. "Prepare release" or null.' },
    description: {
      ...nullableText,
      description: 'Work description, e.g. "Collect review" or null.',
    },
    status: { ...nullableText, description: 'Work status, e.g. "open" or null.' },
    priority: { ...nullableText, description: 'Work priority, e.g. "high" or null.' },
    dueAt: { ...nullableText, description: 'Due-time text, e.g. "2026-09-30" or null.' },
    deadline: { ...nullableText, description: 'Deadline text, e.g. "Friday" or null.' },
    deadlineOffsetMinutes: {
      description: 'Deadline offset from the stated event, e.g. 60 or null.',
      oneOf: [{ type: 'integer', minimum: -840, maximum: 840 }, { type: 'null' }],
    },
    stage: { ...nullableText, description: 'Current work stage, or null to clear it.' },
    project: {
      ...nullableText,
      description: 'project associated with the work, or null to clear it.',
    },
    lastEventTime: {
      ...nullableText,
      description:
        'Timezone-qualified ISO timestamp for the source event time, not replay time, or null.',
    },
    files: {
      description: 'Relevant file locator/version/hash entries preserved with the work, or null.',
      oneOf: [{ type: 'array', items: workFileSchema }, { type: 'null' }],
    },
    completionCriteria: {
      type: 'string',
      pattern: '\\S',
      description: 'Evidence-based completion rule, e.g. "Owner approves".',
    },
    assignee: { ...nullableText, description: 'Assigned person text, e.g. "person_123" or null.' },
    assigneeText: {
      ...nullableText,
      description: 'Unresolved assignee text, e.g. "reviewer" or null.',
    },
    latestEvent: {
      ...nullableText,
      description: 'Latest work event text, e.g. "review requested" or null.',
    },
    confirmed: {
      description: 'Whether the patch is confirmed, e.g. true or null.',
      oneOf: [{ type: 'boolean' }, { type: 'null' }],
    },
    roles: {
      description:
        'Evidence-backed role entries with personRef, role, evidenceRefs and confirmed; use false for an explicit unconfirmed status, or null.',
      oneOf: [{ type: 'array', items: workRoleSchema }, { type: 'null' }],
    },
    data: {
      description: 'Product-specific structured fields, e.g. {"stage":"review"} or null.',
      oneOf: [{ type: 'object' }, { type: 'null' }],
    },
  },
};

const commandFields: Record<string, ActionSchemaObject> = {
  topic: { type: 'string', minLength: 1, description: 'Work topic key, e.g. "release".' },
  summary: {
    type: 'string',
    minLength: 1,
    description: 'What changed and why, e.g. "Review is requested".',
  },
  reasoning: {
    type: 'string',
    minLength: 1,
    description: 'Decision reasoning, e.g. "The source confirms the handoff".',
  },
  scopes: {
    type: 'array',
    description: 'Work visibility scopes, e.g. [{"kind":"project","id":"project_123"}].',
    items: scopeRefSchema,
  },
  sourceRefs: {
    type: 'array',
    description: 'Stable observationRef citation handles, e.g. ["obs_123"].',
    items: { type: 'string', minLength: 1 },
  },
  links: {
    type: 'array',
    description:
      'Evidence graph links, e.g. [{"relation":"derived_from","target":{"kind":"observation","id":"obs_123"}}].',
    items: recordLinkSchema,
  },
  eventDatetime: {
    description:
      'Source event time as epoch milliseconds, not replay time, or null, e.g. 1760000000000.',
    oneOf: [{ type: 'number' }, { type: 'null' }],
  },
  recordedAt: {
    type: 'number',
    description: 'Record time as epoch milliseconds, e.g. 1760000000000.',
  },
  event: { type: 'object', description: 'Structured event details, e.g. {"kind":"review"}.' },
};

const createSchema: ActionSchemaObject = {
  type: 'object',
  required: ['topic', 'summary', 'set'],
  additionalProperties: false,
  properties: {
    ...commandFields,
    set: {
      ...workPatchSchema,
      description: 'Fields to set on the new work item, e.g. {"title":"Prepare release"}.',
    },
  },
};

const reviseSchema: ActionSchemaObject = {
  type: 'object',
  required: ['commitmentId', 'expectedRevision', 'topic', 'summary'],
  additionalProperties: false,
  properties: {
    ...commandFields,
    commitmentId: {
      type: 'string',
      minLength: 1,
      description: 'stable commitmentId citation handle to revise, e.g. "commitment_123".',
    },
    expectedRevision: {
      type: 'integer',
      minimum: 0,
      description: 'Revision read before editing, e.g. 2.',
    },
    set: {
      ...workPatchSchema,
      description: 'Fields to update on the existing work item, e.g. {"assignee":null}.',
    },
    clear: {
      type: 'array',
      description: 'Patch fields to clear, e.g. ["assignee"].',
      items: { type: 'string' },
    },
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

export function assertReplayEventDatetime(
  body: Record<string, unknown>,
  context: ActionContext,
  action: 'work.create' | 'work.revise'
): void {
  const ceiling = context.session?.replaySourceEndMs;
  if (ceiling === undefined) return;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new JudgmentError(
      'REPLAY_SOURCE_CEILING_INVALID',
      'Replay source ceiling must be a nonnegative epoch millisecond integer'
    );
  }
  const eventDatetime = body.eventDatetime;
  if (
    typeof eventDatetime !== 'number' ||
    !Number.isSafeInteger(eventDatetime) ||
    eventDatetime <= 0
  ) {
    throw new JudgmentError(
      'REPLAY_EVENT_TIME_REQUIRED',
      `${action} requires eventDatetime during replay`
    );
  }
  if (eventDatetime > ceiling) {
    throw new JudgmentError(
      'REPLAY_EVENT_TIME_AFTER_CEILING',
      `${action} eventDatetime is later than the active replay source ceiling`
    );
  }
}

export function minimalWorkActionRegistrations(ports: WorkPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'work.create',
        recallableWrite: true,
        summary:
          'Create one owner-work commitment. Product fields such as assignee and roles remain part of the revision patch; links with relation derived_from cite the observations the work rests on.',
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
        assertReplayEventDatetime(body, context, 'work.create');
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
          'Revise owner work at an expected revision. The required summary states what changed and why, in one or two sentences. Compare-and-set prevents overwriting a revision the caller did not read; links with relation derived_from cite the observations the revision rests on.',
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
        assertReplayEventDatetime(body, context, 'work.revise');
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
