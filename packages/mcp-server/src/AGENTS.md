# MCP SERVER PACKAGE

**Package:** `@jungjaehoon/mama-server`  
**Purpose:** MCP transport layer for Claude Desktop/Code  
**Entry:** `src/server.js` (bin: `mama-server`)

---

## OVERVIEW

Stdio-based MCP server. This package is a thin protocol adapter — it owns **no database
handle and no embedding model**. Every tool call is an action request on the shared
runtime socket, through the same common client the CLI uses.

**Architecture:** MCP SDK → `call(action, input)` → runtime socket → action catalog/dispatch → Knowledge

Per the unified-core design, this package never imports core internals for business
operations — no `mama-api`, no `db-manager`, no adapter functions.

---

## STRUCTURE

```
src/
├── server.js                    # Entry point (MAMAServer class, stdio transport)
├── runtime-client.js            # openRuntimeClient() / callAction() — socket client binding
├── tools/                       # MCP tool handlers — each takes { call }
│   ├── index.js                 # createMemoryTools({ call }) registry
│   ├── checkpoint-tools.js      # save/load checkpoint (memory.checkpoint.*, graph.query)
│   ├── save-decision.js         # save (decision) handler (memory.save)
│   ├── search-narrative.js      # search handler (memory.search)
│   ├── update-outcome.js        # update handler (memory.update)
│   ├── suggest-decision.js      # suggest (memory.search with query)
│   ├── recall-decision.js       # recall by topic (memory.read:topic)
│   ├── list-decisions.js        # list recent (memory.search, no query)
│   ├── search-decisions-and-contracts.js  # decision + contract lookup (memory.search)
│   ├── case-timeline-range.js   # bounded case timeline (graph.query view:'timeline')
│   └── ingest-conversation.js   # conversation ingest (source.ingest)
└── mama/
    └── response-formatter.js    # MCP response formatting
└── db/migrations/               # SQLite schema migrations (inherited from mama-core)
```

---

## MCP TOOLS

| Tool                             | Action(s)                                                            | Description                                         |
| -------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| `save`                           | `memory.save` / `memory.checkpoint.save`                             | Unified save (decision or checkpoint)               |
| `search`                         | `memory.search` / `memory.checkpoint.load`                           | Semantic search, list recent, or resume             |
| `update`                         | `memory.update`                                                      | Update decision outcome (success/failed)            |
| `search_decisions_and_contracts` | `memory.search` (×2)                                                 | Decisions + `contract_`-prefixed topics             |
| `case_timeline_range`            | `graph.query` view `'timeline'`                                      | Bounded case history window                         |
| `load_checkpoint`                | `memory.checkpoint.load` + `memory.search` + `graph.query` neighbors | Resume previous session (unadvertised compat alias) |

**Tool contract:** factories take `{ call }` — `call(action, input)` resolves to the
action's data payload. Action failures throw (code/status/operationId preserved);
never collapse a failed dispatch into an empty success.

---

## PROTOCOL

**Transport:** stdio (standard MCP pattern)  
**Format:** JSON-RPC 2.0  
**Handlers:** `ListToolsRequestSchema`, `CallToolRequestSchema`  
**No HTTP:** MCP uses stdin/stdout only. There is no MCP-owned HTTP listener and no
embedding startup path — embeddings are the runtime's concern.

---

## DEPENDENCIES

**Runtime boundary:** `runtime-client.js` resolves `MAMA_HOME` for
`runtime.sock`, `runtime/client-journal.jsonl`, and `session-credential`, then binds
`createClient` from `@jungjaehoon/mama-core`. The runtime owns the store and the
embedding model; a missing credential means calls are denied — that is the honest
answer when no session exists.

**MCP SDK:** `@modelcontextprotocol/sdk` v1.0.1

---

## NOTES

- **No business logic here:** all save/search/update logic lives in mama-core
  behind the action catalog.
- **No provenance forwarding:** tools never accept or forward caller-supplied
  provenance; the server composes it from the session's own access.
- **Runtime:** stdio only.
- **Node.js:** >= 22.13.0 required
