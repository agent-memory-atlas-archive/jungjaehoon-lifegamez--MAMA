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
    source: { type: 'string' as const, pattern: '\\S' },
    view: { type: 'string' as const, enum: ['stored'] },
    detail: { type: 'string' as const, enum: ['compact', 'full'] },
    channel: { type: 'string' as const },
    from: timeValue,
    to: timeValue,
    query: { type: 'string' as const },
    limit: { type: 'integer' as const, minimum: 1, maximum: 100 },
    cursor: { type: 'string' as const },
    observationRef: { type: 'string' as const, pattern: '\\S' },
    content_offset: { type: 'integer' as const, minimum: 0 },
    content_limit: { type: 'integer' as const, minimum: 1, maximum: 4_000 },
  },
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
        inputSchema: sourceSchema,
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
