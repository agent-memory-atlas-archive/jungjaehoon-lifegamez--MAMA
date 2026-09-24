import type { ActionRegistration, ActionSchemaObject } from '@jungjaehoon/mama-core';
import type { StoredSourceReader } from './stored-source-reader.js';

export interface SourcePorts {
  stored?: StoredSourceReader | null;
}

function sourceName(input: unknown, action: string): string {
  const source = (input as { source?: unknown }).source;
  if (typeof source !== 'string' || source.trim() === '') {
    const error = new Error(`${action} requires a nonblank source`);
    error.name = 'invalid_input';
    throw error;
  }
  return source.trim();
}

function storedReader(ports: SourcePorts): StoredSourceReader {
  if (!ports.stored) {
    const error = new Error('Stored source reader is not configured');
    error.name = 'source_unavailable';
    throw error;
  }
  return ports.stored;
}

const timeValue: ActionSchemaObject = {
  description: 'Epoch milliseconds or timezone-aware ISO time, e.g. 1760000000000.',
  oneOf: [
    { type: 'integer', minimum: 0 },
    {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T.*(?:Z|[+-]\\d{2}:\\d{2})$',
    },
  ],
};

const sourceSchema = {
  type: 'object' as const,
  required: ['source'],
  additionalProperties: false,
  properties: {
    source: {
      type: 'string' as const,
      pattern: '\\S',
      description: 'Connector name, e.g. "slack"; do not put the message id here.',
    },
    view: { type: 'string' as const, enum: ['stored'], description: 'Read view, e.g. "stored".' },
    detail: {
      type: 'string' as const,
      enum: ['compact', 'full'],
      description: 'Search result detail, e.g. "full".',
    },
    channel: {
      type: 'string' as const,
      description: 'Connector channel filter, e.g. "channel_123".',
    },
    from: timeValue,
    to: timeValue,
    query: {
      type: 'string' as const,
      description: 'Text to find in preserved observations, e.g. "review".',
    },
    limit: {
      type: 'integer' as const,
      minimum: 1,
      maximum: 100,
      description: 'Maximum search hits, e.g. 20.',
    },
    cursor: {
      type: 'string' as const,
      description: 'Opaque search page cursor, e.g. "cursor_20".',
    },
    observationRef: {
      type: 'string' as const,
      pattern: '\\S',
      description: 'Exact stored observation handle returned by search/delta, e.g. "obs_123".',
    },
    content_offset: {
      type: 'integer' as const,
      minimum: 0,
      description: 'Character offset for a bounded read, e.g. 0.',
    },
    content_limit: {
      type: 'integer' as const,
      minimum: 1,
      maximum: 4_000,
      description: 'Maximum characters returned by a read, e.g. 4000.',
    },
  },
};

const sourceReadSchema = {
  ...sourceSchema,
  required: ['source', 'observationRef'] as const,
};

export function sourceActionRegistrations(ports: SourcePorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'source.search',
        readsConnector: { fromInput: 'source' },
        summary:
          'Search or page preserved source observations. Search results are bounded navigation hits; read the cited observation explicitly for the original content.',
        inputSchema: sourceSchema,
        examples: [
          {
            title: 'Find preserved source evidence',
            input: { source: 'connector', query: 'term', detail: 'compact' },
          },
        ],
      },
      exec: (input, context) => {
        const source = sourceName(input, 'source.search');
        return storedReader(ports).search(source, input as Record<string, unknown>, context.access);
      },
    },
    {
      contract: {
        name: 'source.read',
        readsConnector: { fromInput: 'source' },
        summary:
          'Read a bounded slice of one preserved source observation by citation reference. Continue with nextRead until complete.',
        inputSchema: sourceReadSchema,
        examples: [
          {
            title: 'Read cited source evidence',
            input: { source: 'connector', observationRef: 'observation-reference' },
          },
        ],
      },
      exec: (input, context) => {
        const source = sourceName(input, 'source.read');
        return storedReader(ports).read(source, input as Record<string, unknown>, context.access);
      },
    },
  ];
}
