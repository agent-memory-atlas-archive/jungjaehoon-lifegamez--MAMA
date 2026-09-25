/** Wiki actions bind native owner calls to the configured vault and file publisher. */
import type { ActionRegistration } from '@jungjaehoon/mama-core';
import {
  listWikiPages,
  readWikiPages,
  WIKI_LIST_MAX_PATHS,
  WIKI_READ_MAX_PAGE_CHARS,
} from '../wiki/wiki-read.js';
import { WIKI_PAGE_TYPES } from '../wiki/types.js';
import {
  createWikiPublishAdapter,
  MAX_WIKI_PAGE_CONTENT_CHARS,
  type WikiPublishAdapter,
} from '../wiki-artifacts/wiki-publish-adapter.js';
import type { WikiPagePublisher, WikiPublishPageInput } from '../wiki-artifacts/types.js';

export interface WikiVaultBinding {
  path: string;
  name: string | null;
  /** Set once the CLI proves it targets this vault; host-owned mutable state. */
  verified?: boolean;
}

export interface WikiPorts {
  /** The configured wiki vault — absent until the wiki agent opens it. */
  vault?: WikiVaultBinding | null;
  /** The page writer the api routes bind (ObsidianWriter callback). */
  publisher?: WikiPagePublisher | null;
  /** An override publish adapter; defaults to createWikiPublishAdapter(publisher). */
  publishAdapter?: WikiPublishAdapter | null;
}

const namedError = (code: string, message: string): Error => {
  const error = new Error(message);
  error.name = code;
  return error;
};

function requireVault(ports: WikiPorts): WikiVaultBinding {
  if (!ports.vault) {
    throw namedError('TOOL_ERROR', 'Wiki vault path not configured');
  }
  return ports.vault;
}

export function wikiActionRegistrations(ports: WikiPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'manage.wiki.publish',
        summary:
          'Publish wiki pages in the configured vault. pages is an array of page objects with relative path, title and Markdown content string. Read an existing page first and pass its expectedContentVersion to update it; use null for a new versioned file. sourceRefs can name exact raw observations.',
        inputSchema: {
          type: 'object',
          required: ['pages'],
          properties: {
            pages: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'title', 'content'],
                properties: {
                  path: { type: 'string', minLength: 1 },
                  title: { type: 'string', minLength: 1 },
                  type: { type: 'string', enum: WIKI_PAGE_TYPES },
                  content: { type: 'string', minLength: 1, maxLength: MAX_WIKI_PAGE_CONTENT_CHARS },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  expectedContentVersion: {
                    oneOf: [{ type: 'string' }, { type: 'null' }],
                  },
                  sourceIds: { type: 'array', items: { type: 'string' } },
                  sourceRefs: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        examples: [
          {
            title: 'Publish one evidence-linked current-state page',
            input: {
              pages: [
                {
                  path: 'work/current.md',
                  title: 'Current work state',
                  type: 'synthesis',
                  content: '# Current work state\n\nDated facts, evidence, and open questions.',
                  expectedContentVersion: null,
                  sourceRefs: [{ kind: 'raw', connector: 'chatwork', id: 'obs_example' }],
                },
              ],
            },
          },
        ],
      },
      exec: (input) => {
        const pagesInput = (input as { pages?: WikiPublishPageInput[] }).pages;
        if (!pagesInput || !Array.isArray(pagesInput)) {
          throw namedError('TOOL_ERROR', 'manage.wiki.publish requires pages array');
        }
        const adapter =
          ports.publishAdapter ?? createWikiPublishAdapter({ publisher: ports.publisher });
        try {
          const publishResult = adapter.publish({ pages: pagesInput });
          return {
            success: true,
            message: `Wiki published: ${publishResult.pagesPublished} pages`,
            artifactsStored: publishResult.artifactsStored,
          };
        } catch (error) {
          throw namedError(
            'TOOL_ERROR',
            error instanceof Error ? error.message : 'Wiki publish failed'
          );
        }
      },
    },
    {
      contract: {
        name: 'manage.wiki.read',
        summary:
          'List wiki paths with no paths (page using nextCursor and readVersion as list_cursor/list_version), or read exact relative .md paths from the configured wiki directory. Continue long page content using nextContentOffset and the same content_versions entry; restart if its version changes.',
        inputSchema: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string', pattern: '^.+\\.md$' } },
            list_cursor: { type: 'string', minLength: 1 },
            list_version: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            list_limit: { type: 'integer', minimum: 1, maximum: WIKI_LIST_MAX_PATHS },
            content_offset: { type: 'integer', minimum: 0 },
            content_limit: { type: 'integer', minimum: 1, maximum: WIKI_READ_MAX_PAGE_CHARS },
            content_versions: { type: 'object' },
          },
        },
        examples: [
          { title: 'List wiki page paths', input: { list_limit: 50 } },
          {
            title: 'Read one current-state page',
            input: { paths: ['work/current.md'], content_limit: 4_000 },
          },
        ],
      },
      exec: (input) => {
        const vault = requireVault(ports);
        const readInput = input as {
          paths?: unknown;
          list_cursor?: unknown;
          list_version?: unknown;
          list_limit?: unknown;
          content_offset?: unknown;
          content_limit?: unknown;
          content_versions?: Record<string, string | null>;
        };
        try {
          const listing =
            readInput.paths === undefined ||
            (Array.isArray(readInput.paths) && readInput.paths.length === 0);
          if (listing) {
            if (
              readInput.content_offset !== undefined ||
              readInput.content_limit !== undefined ||
              readInput.content_versions !== undefined
            ) {
              throw new Error('manage.wiki.read list cannot combine with content read options');
            }
            return {
              success: true,
              ...listWikiPages({
                root: vault.path,
                cursor: readInput.list_cursor,
                version: readInput.list_version,
                limit: readInput.list_limit,
              }),
            };
          }
          if (
            readInput.list_cursor !== undefined ||
            readInput.list_version !== undefined ||
            readInput.list_limit !== undefined
          ) {
            throw new Error('manage.wiki.read content cannot combine with list options');
          }
          return {
            success: true,
            ...readWikiPages({
              root: vault.path,
              paths: readInput.paths,
              contentOffset: readInput.content_offset,
              contentLimit: readInput.content_limit,
              contentVersions: readInput.content_versions,
            }),
          };
        } catch (error) {
          throw namedError(
            'TOOL_ERROR',
            error instanceof Error ? error.message : 'Wiki read failed'
          );
        }
      },
    },
  ];
}
