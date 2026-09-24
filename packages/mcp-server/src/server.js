#!/usr/bin/env node

/**
 * MAMA MCP Server
 *
 * Memory-Augmented MCP Assistant - MCP protocol adapter
 *
 * This server provides MCP tools for decision tracking, semantic search,
 * and decision graph navigation across Claude Code and Claude Desktop.
 *
 * Architecture:
 * - Stdio transport (standard MCP pattern)
 * - Thin protocol adapter: every tool call is an action request on the
 *   runtime's private socket via the shared core client. This process owns
 *   no database handle and no embedding model — `runtime.start` does.
 * - No network dependencies (100% local)
 *
 * Usage:
 *   node src/server.js                 # Direct execution
 *   mama-server                        # Via bin (npm install -g)
 *   npx @jungjaehoon/mama-server           # Via npx
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Import all MAMA tools from src/tools/ — single source of truth for tool definitions
const { createMemoryTools } = require('./tools/index.js');
const { openRuntimeClient, callAction } = require('./runtime-client.js');
const { version: PACKAGE_VERSION } = require('../package.json');

/**
 * MAMA MCP Server Class
 */
class MAMAServer {
  constructor() {
    this.server = new Server(
      {
        name: 'mama-server',
        version: PACKAGE_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.listToolDefinitions(),
    }));
    this.registerCallToolHandler();
  }

  listToolDefinitions() {
    const memoryTools = this.memoryTools;
    return [
      // 1. SAVE — decisions, checkpoints, conversation ingestion
      {
        name: 'save',
        description: `Save to MAMA memory. Use type parameter to choose what to save.

**type='decision'** — Save architectural decisions, lessons learned, insights.
  Required: topic, decision, reasoning. Optional: confidence, scopes, event_date.
  Triggers: user says "기억해", "remember", "decided". Topic reuse alone does not create a relationship.

**type='checkpoint'** — Save session state for resumption.
  Required: summary (4-section: Goal, Evidence, Unfinished, Next Briefing).
  Optional: next_steps, open_files. Triggers: session ending, "체크포인트", "save progress".

**type='ingest'** — Import conversation messages into memory as a raw source observation.
  Required: messages (array of {role, content}). Optional: scopes, session_date.

**Scopes**: Isolate memories per project/channel. Example: [{"kind":"project","id":"/my/app"}]
**event_date**: ISO 8601 date when event occurred (e.g. "2024-01-15"), not when saved.`,
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['decision', 'checkpoint', 'ingest'],
              description: "What to save: 'decision', 'checkpoint', or 'ingest'",
            },
            // Decision fields
            topic: {
              type: 'string',
              description:
                '[Decision] Topic identifier. Relationships require explicit referenced IDs.',
            },
            decision: {
              type: 'string',
              description: '[Decision] The decision made.',
            },
            reasoning: {
              type: 'string',
              description: "[Decision] Why. End with 'builds_on: <id>' or 'debates: <id>' to link.",
            },
            confidence: {
              type: 'number',
              description: '[Decision] 0.0-1.0. Default: 0.5',
              minimum: 0,
              maximum: 1,
            },
            scopes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
                  id: { type: 'string' },
                },
                required: ['kind', 'id'],
              },
              description: 'Memory scopes for isolation.',
            },
            event_date: {
              type: 'string',
              description: 'ISO 8601 date when event occurred (e.g. "2024-01-15").',
            },
            item: {
              type: 'string',
              description: '[Decision] Explicit registry item node id.',
            },
            actors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  person: { type: 'string' },
                  role: { type: 'string' },
                },
                required: ['person', 'role'],
              },
              description: '[Decision] Explicit registry person nodes and their roles.',
            },
            // Checkpoint fields
            summary: {
              type: 'string',
              description: '[Checkpoint] Session state summary.',
            },
            next_steps: {
              type: 'string',
              description: '[Checkpoint] Instructions for next session.',
            },
            open_files: {
              type: 'array',
              items: { type: 'string' },
              description: '[Checkpoint] Currently relevant files.',
            },
            // Ingest fields
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
              },
              description: '[Ingest] Conversation messages to import.',
            },
            session_date: {
              type: 'string',
              description: '[Ingest] ISO 8601 date when conversation occurred.',
            },
          },
          required: ['type'],
        },
      },
      // 2. SEARCH — unified search across decisions, checkpoints, load latest checkpoint
      {
        name: 'search',
        description: `Search MAMA memory. Returns results ranked by semantic similarity.

**With query** — Semantic search across decisions and checkpoints. Cross-lingual (Korean + English).
  Triggers: "뭐였더라", "what did we decide", making architectural choices, debugging.

**Without query** — List recent items sorted by time.

**Resume session**: type='checkpoint' without query → loads latest checkpoint with full context (narrative, links, next steps).
  Triggers: "이어서", "continue", "where were we", session start.

**type parameter**: 'decision' (choices/lessons only), 'checkpoint' (session states / resume), 'all' (both, default).
**scopes**: Filter by project/channel. Omit for global search.
**limit**: Max results (default: 10).

⚠️ REQUIRED: Call search BEFORE save to find related decisions and avoid orphans.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query. Omit to list recent items.',
            },
            type: {
              type: 'string',
              enum: ['all', 'decision', 'checkpoint'],
              description: "Filter by type. Default: 'all'",
            },
            limit: { type: 'number', description: 'Max results. Default: 10' },
            threshold: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Minimum retrieval threshold. Omit for mode default.',
            },
            strict: {
              type: 'boolean',
              description: 'Shortcut for strict search mode.',
            },
            strictness: {
              type: 'string',
              enum: ['recall', 'balanced', 'strict'],
              description: "Search quality mode. Default: 'recall'.",
            },
            disableRecency: {
              type: 'boolean',
              description: 'Disable recency weighting in search.',
            },
            includeRelated: {
              type: 'boolean',
              description: 'Include related graph-expanded results.',
            },
            topicPrefix: {
              type: 'string',
              description: 'Restrict search to topics with this prefix.',
            },
            minLexicalSupport: {
              type: 'boolean',
              description: 'Require lexical/entity/exact-topic confirmation.',
            },
            diagnostics: {
              type: 'boolean',
              description: 'Return retrieval diagnostics for search quality inspection.',
            },
            scopes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
                  id: { type: 'string' },
                },
                required: ['kind', 'id'],
              },
              description: 'Filter by scope.',
            },
          },
        },
      },
      // 3. UPDATE — decision outcome tracking
      {
        name: 'update',
        description: `Update decision outcome after real-world validation.

Triggers: "이거 안됐어", "this worked", days later when issues discovered.
outcome: 'success', 'failed', 'partial' (case-insensitive).
After failure → save a NEW decision and explicitly reference any relationship in its reasoning.`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Decision ID to update.' },
            outcome: {
              type: 'string',
              description: "'success', 'failed', or 'partial' (case-insensitive).",
            },
            reason: {
              type: 'string',
              description: 'Why it succeeded/failed/was partial. Include evidence.',
            },
          },
          required: ['id', 'outcome'],
        },
      },
      // 4. SEARCH_DECISIONS_AND_CONTRACTS — PreToolUse hook RPC (defined in src/tools/)
      {
        name: memoryTools.search_decisions_and_contracts.name,
        description: memoryTools.search_decisions_and_contracts.description,
        inputSchema: memoryTools.search_decisions_and_contracts.inputSchema,
      },
      // 5. CASE_TIMELINE_RANGE — Phase 3 case timeline RPC (defined in src/tools/)
      {
        name: memoryTools.case_timeline_range.name,
        description: memoryTools.case_timeline_range.description,
        inputSchema: memoryTools.case_timeline_range.inputSchema,
      },
    ];
  }

  registerCallToolHandler() {
    // Handle tool execution — legacy wrappers + v2 tools from src/tools/
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolStart = Date.now();
      console.error(`[MAMA MCP] Tool start: ${name}`);

      try {
        let result;

        switch (name) {
          // Legacy unified wrappers (backward compat)
          case 'save':
            result = await this.handleSave(args);
            break;
          case 'search':
            result = await this.handleSearch(args);
            break;
          case 'update':
            result = await this.handleUpdate(args);
            break;
          default:
            // All other tools → src/tools/ handlers (single source of truth)
            if (this.memoryTools[name] && typeof this.memoryTools[name].handler === 'function') {
              result = await this.memoryTools[name].handler(args);
            } else {
              throw new Error(`Unknown tool: ${name}`);
            }
        }

        console.error(`[MAMA MCP] Tool done: ${name} (${Date.now() - toolStart}ms)`);

        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(`[MAMA MCP] Tool failed: ${name} (${Date.now() - toolStart}ms)`);
        console.error('[MAMA MCP] Tool execution error:', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle unified save (decision or checkpoint)
   */
  async handleSave(args) {
    const { type } = args;

    if (type === 'decision') {
      const {
        topic,
        decision,
        reasoning,
        confidence = 0.5,
        scopes,
        event_date,
        item,
        actors,
      } = args;
      if (!topic || !decision || !reasoning) {
        return { success: false, message: '❌ Decision requires: topic, decision, reasoning' };
      }
      const saved = await this.call('memory.save', {
        topic,
        kind: 'decision',
        summary: decision,
        details: reasoning,
        confidence,
        ...(scopes && { scopes }),
        ...(event_date && { eventDate: event_date }),
        ...(item && { itemId: item }),
        ...(actors && {
          actors: actors.map((a) => ({ personId: a.person, role: a.role })),
        }),
        source: { package: 'mcp-server', source_type: 'mcp_save' },
      });
      const id = saved?.saved_decision_id ?? saved?.id;
      return {
        success: true,
        id,
        type: 'decision',
        message: `✅ Decision saved: ${topic}`,
      };
    }

    if (type === 'checkpoint') {
      const { summary, next_steps, open_files } = args;
      if (!summary) {
        return { success: false, message: '❌ Checkpoint requires: summary' };
      }
      const saved = await this.call('memory.checkpoint.save', {
        summary,
        ...(open_files && { open_files }),
        ...(next_steps && { next_steps }),
      });
      return {
        success: true,
        id: saved?.id,
        type: 'checkpoint',
        message: '✅ Checkpoint saved',
      };
    }

    if (type === 'ingest') {
      return await this.memoryTools.ingest_conversation.handler(args);
    }

    return { success: false, message: "❌ type must be 'decision', 'checkpoint', or 'ingest'" };
  }

  /**
   * Handle unified search — the same contract the gateway's mama_search
   * serves: `type='checkpoint'` restores the latest checkpoint (scopes are
   * rejected rather than silently bypassed), every other read goes through
   * `memory.search`.
   */
  async handleSearch(args) {
    const {
      query,
      type = 'all',
      limit = 10,
      scopes,
      threshold,
      strict,
      strictness,
      disableRecency,
      includeRelated,
      topicPrefix,
      minLexicalSupport,
      diagnostics,
    } = args;

    // type='checkpoint' restores the latest checkpoint — the resume read.
    // Checkpoints are not scope-bound, so a scoped request is rejected
    // explicitly rather than silently bypassing scope isolation.
    if (type === 'checkpoint') {
      if (Array.isArray(scopes) && scopes.length > 0) {
        return {
          success: false,
          code: 'scoped_checkpoint_unsupported',
          count: 0,
          results: [],
          message: 'Scoped checkpoint reads are not supported yet',
        };
      }
      const checkpoint = await this.call('memory.checkpoint.load', {});
      if (checkpoint && typeof checkpoint === 'object' && 'summary' in checkpoint) {
        return {
          success: true,
          count: 1,
          results: [
            {
              id: `checkpoint_${checkpoint.id ?? 'latest'}`,
              summary: checkpoint.summary,
              next_steps: checkpoint.next_steps,
              created_at: checkpoint.timestamp,
              _type: 'checkpoint',
            },
          ],
        };
      }
      return { success: true, count: 0, results: [] };
    }

    const hasScopes = Array.isArray(scopes) && scopes.length > 0;

    if (!query) {
      // No query + topicPrefix is a ledger read: exactly the records filed
      // under one item key.
      const listed = await this.call('memory.search', {
        limit,
        ...(hasScopes && { scopes }),
        ...(typeof topicPrefix === 'string' && topicPrefix.length > 0 && { topicPrefix }),
      });
      const raw = Array.isArray(listed?.results) ? listed.results : [];
      let results = raw.filter((item) => item && typeof item === 'object' && 'id' in item);
      if (type === 'decision') {
        // Result rows discriminate by source_type ('decision', 'contract',
        // 'wiki_page', ...) — unified judgment ids carry no legacy prefix.
        results = results.filter((item) => item.source_type === 'decision');
      }
      results = results.map((d) => ({ ...d, _type: 'decision' }));
      return { success: true, count: results.length, results };
    }

    const result = await this.call('memory.search', {
      query,
      limit,
      ...(hasScopes && { scopes }),
      ...(threshold !== undefined && { threshold }),
      ...(strict !== undefined && { strict }),
      ...(strictness !== undefined && { strictness }),
      ...(disableRecency !== undefined && { disableRecency }),
      ...(includeRelated !== undefined && { includeRelated }),
      ...(topicPrefix !== undefined && { topicPrefix }),
      ...(minLexicalSupport !== undefined && { minLexicalSupport }),
      ...(diagnostics !== undefined && { diagnostics }),
    });
    // Preserve the failure signal — collapsing a null/invalid search result
    // to [] would make callers unable to distinguish "no matches" from
    // "search pipeline failed".
    if (!result || typeof result !== 'object') {
      return {
        success: false,
        code: 'suggest_returned_null',
        count: 0,
        results: [],
        message: 'Search failed: memory.search returned no result for query',
      };
    }
    if (result.success === false) {
      const hasOwn = Object.prototype.hasOwnProperty;
      const forwarded = {
        ...result,
        success: false,
        code: result.code || 'suggest_failed',
      };
      if (!hasOwn.call(forwarded, 'count')) {
        forwarded.count = 0;
      }
      if (!hasOwn.call(forwarded, 'results')) {
        forwarded.results = [];
      }
      if (!hasOwn.call(forwarded, 'message')) {
        forwarded.message = result.error || 'Search pipeline failed';
      }
      return forwarded;
    }
    const searchDiagnostics = result.diagnostics;

    let results = (Array.isArray(result.results) ? result.results : [])
      .filter((item) => item && typeof item === 'object' && 'id' in item)
      .map((d) => ({ ...d, _type: 'decision' }));
    if (type === 'decision') {
      results = results.filter((item) => item.source_type === 'decision');
    }
    results = results.slice(0, limit);

    return {
      success: true,
      query,
      count: results.length,
      results,
      ...(searchDiagnostics !== undefined ? { diagnostics: searchDiagnostics } : {}),
      ...(result.meta !== undefined ? { meta: result.meta } : {}),
    };
  }

  /**
   * Handle update (decision outcome)
   * Story 3.1: Case-insensitive outcome support
   */
  async handleUpdate(args) {
    const { id, outcome, reason } = args;

    if (!id || !outcome) {
      return { success: false, message: '❌ Update requires: id, outcome' };
    }

    // Story 3.1: Normalize outcome - handle both 'failure' and 'failed' variants
    let normalizedOutcome = outcome.toUpperCase();
    if (normalizedOutcome === 'FAILURE') {
      normalizedOutcome = 'FAILED';
    }

    await this.call('memory.update', {
      id,
      outcome: normalizedOutcome,
      ...(reason !== undefined && { failure_reason: reason }),
    });

    return {
      success: true,
      message: `✅ Updated ${id} → ${normalizedOutcome}`,
    };
  }

  /**
   * Bind the shared action caller: every handler and tool reaches the action
   * catalog through it. start() binds the socket client; tests may bind a
   * dispatch-backed call over their own adapter or a stub.
   */
  bindRuntime(call) {
    this.call = call;
    this.memoryTools = createMemoryTools({ call });
  }

  async start() {
    try {
      // No database in this process — `runtime.start` owns it. The common
      // client binds the runtime socket, the shared operation journal, and
      // this boot's session credential. A missing runtime surfaces per call
      // as `ipc_unavailable` naming the real start command.
      this.bindRuntime((action, input) => callAction(openRuntimeClient(), action, input));

      // Start the stdio MCP server.
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      // Log to stderr (stdout is for MCP JSON-RPC)
      console.error('[MAMA MCP] Server started successfully');
      console.error('[MAMA MCP] Listening on stdio transport');
      console.error('[MAMA MCP] Ready to accept connections');
    } catch (error) {
      console.error('[MAMA MCP] Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Start server if run directly
if (require.main === module) {
  const server = new MAMAServer();
  server.start().catch((error) => {
    console.error('[MAMA MCP] Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { MAMAServer };
