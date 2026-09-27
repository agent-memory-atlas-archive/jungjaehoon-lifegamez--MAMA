# MAMA

An owner agent, development memory, and a shared engine for work that carries over.

- **MAMA OS** is one owner agent on Claude or Codex. It watches connected work sources, keeps
  task history and evidence, answers on Telegram, publishes reports and a board, and recalls
  owner corrections.
- **Development memory** gives Claude Code decisions and checkpoints through commands, hooks,
  and an in-process MCP server.
- **mama-core** provides storage, revisions, evidence links, search, memory and runtime drivers.
  Other products use its public exports with their own data.

MAMA runs on your computer. Records and the embedding index are local; model requests,
configured connectors and native web tools can send content to external services.
There is no hosted MAMA service.

## Who it is for

Owners who need to follow work across conversations and work tools, and developers who need
decisions and context to survive a new coding session. Task history and similar-case search
are the focus. Team use comes after the owner checks pass on real data.

## Getting started

These instructions describe the **unreleased `rebuild/owner-flow` branch**. Use Node.js 22.13+
and build this checkout; published packages may still describe the earlier product.

| Start path                                                    | What you need                                                                                                                  | Data home                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| [Set up the owner agent](docs/start/owner-setup.md)           | An authenticated Claude or Codex CLI and a Telegram owner chat; run `mama init` in your terminal and type tokens with echo off | `~/.mama/`                            |
| [Set up development memory](docs/start/claude-code-plugin.md) | Claude Code for commands/hooks, or a stdio MCP client for memory tools; no OS daemon required                                  | `~/.claude/mama-memory.db` by default |

Keep the two data homes separate. Follow setup through a real answer or a save-and-retrieve
round trip; process status alone does not establish that the product works.

## How it works

1. **Recognise:** collect originals and changes from Chatwork, Slack, Trello, the Kagemusha
   read-only bridge and Google Calendar through `gws`. The agent decides what work they concern.
2. **Attach:** update tasks with revisions, feedback, materials, roles and evidence. Wiki pages
   and daily journals explain the history.
3. **Answer:** read stored work and sources progressively, search similar cases, and answer
   the owner on Telegram.
4. **Report:** route live changes to a notification or acknowledgement, then refresh the board.
   Full reports default to 08:00, 13:00 and 18:00 KST; hourly reminders run 09:00–21:00.
5. **Learn:** recall relevant lessons, preferences and constraints. Verify a correction on the
   next related request and after a restart.

Historical replay uses day windows through the owner runtime. The viewer shows the board,
work, memory graph, wiki and logs. The agent judges meaning and relevance; the host collects,
stores, searches, executes and retains traces and delivery receipts.
See [the owner loop](docs/explanation/owner-loop.md).

## Security

- The viewer binds to `127.0.0.1` by default. `/health` checks liveness, not owner-answer or
  report delivery. Viewer data routes are read-only.
- Telegram accepts only an allowed chat and owner sender. File delivery uses the configured owner
  destination.
- The owner types onboarding tokens in a terminal. They live in `~/.mama/auth.env` (0600),
  outside the agent's readable files; secret-shaped environment variables are removed before
  either backend starts. Agent writes stay inside the workspace.
- Remote viewer data access requires `MAMA_AUTH_TOKEN` or a verified Cloudflare Access JWT.
  Host allowlisting applies even to public routes; tunnel headers alone do not authenticate.
- External evidence is quoted as untrusted. Recallable writes reject recognised secret shapes;
  this is not complete secret detection or guaranteed prompt-injection protection. Security events
  are recorded, and suspicious request classes alert the owner on Telegram.

Protect the data homes and logs as private owner data. Read the [security guide](docs/guides/security.md)
and [viewer access guide](docs/guides/viewer.md) before enabling remote access.

## Packages

Versions below are the current manifests, not a release of this rebuild.

| Package                                                     | Role                                     | Version |
| ----------------------------------------------------------- | ---------------------------------------- | ------- |
| [MAMA OS](packages/standalone/README.md)                    | Owner loop and `mama` CLI                | 0.57.0  |
| [mama-core](packages/mama-core/README.md)                   | Shared engine and public exports         | 4.0.0   |
| [Public MCP server](packages/mcp-server/README.md)          | In-process development memory over stdio | 2.2.1   |
| [Claude Code plugin](packages/claude-code-plugin/README.md) | Development commands and hooks           | 2.0.1   |

## Status and roadmap

The product layer is rebuilt on `rebuild/owner-flow`. Implemented mechanisms and individual live
checks do not complete the [owner checks in INTENT.md](INTENT.md): recognise, attach, answer,
report and learn, plus the shared-engine goal.

The [rebuild plan](docs/rebuild/plan.md) and [check log](docs/rebuild/checks.md) record what works
and what remains open, including fresh-machine onboarding, scheduled-report delivery and
continuity checks. [TODOs](TODOS.md) retain work that follows those checks.

## Documentation and development

- [Documentation index](docs/index.md)
- [Backends](docs/guides/backends.md) · [Connectors](docs/guides/connectors.md) ·
  [Reports and board](docs/guides/reports-and-board.md) · [Replay](docs/guides/replay.md)
- [Corrections and learning](docs/guides/corrections-and-learning.md) ·
  [Memory and search](docs/explanation/memory-and-search.md)
- [CLI](docs/reference/cli.md) · [Configuration](docs/reference/configuration.md) ·
  [Owner actions](docs/reference/actions.md) · [MCP tools](docs/reference/mcp-tools.md)
- [Architecture](docs/explanation/architecture.md) · [Contributing](docs/development/contributing.md) ·
  [Testing](docs/development/testing.md) · [Release process](docs/development/release-process.md)

Build from the repository root with `pnpm install` and `pnpm build`.
Read [AGENTS.md](AGENTS.md) and [INTENT.md](INTENT.md) before changing the code.

## License

[MIT](LICENSE).
