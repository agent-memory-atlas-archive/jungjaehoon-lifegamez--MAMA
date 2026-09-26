# MAMA documentation

Choose the product you want to use. They share an engine, but keep separate data.

| Start here                                               | What it does                                                                                                           | Data home                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [Set up MAMA OS](start/owner-setup.md)                   | One owner agent watches connected work, keeps task history, answers on Telegram and publishes reports.                 | `~/.mama/`                            |
| [Set up development memory](start/claude-code-plugin.md) | Claude Code commands and hooks save decisions and checkpoints through the public MCP server. No OS daemon is required. | `~/.claude/mama-memory.db` by default |

Read [the product purpose](../INTENT.md) for the recognise, attach, answer, report and learn checks.
The [architecture](explanation/architecture.md) explains the shared engine and package boundaries.

## Run the owner loop

- [Choose a backend](guides/backends.md) and configure its login and isolation.
- [Connect Telegram](guides/telegram.md) for owner messages, attachments and file delivery.
- [Connect work sources](guides/connectors.md) and assign channel roles.
- [Read reports and the board](guides/reports-and-board.md).
- [Replay retained history](guides/replay.md).
- [Maintain the wiki](guides/wiki.md).
- [Correct the agent and verify learning](guides/corrections-and-learning.md).
- [Open the viewer](guides/viewer.md) and review [security boundaries](guides/security.md).
- [Troubleshoot a failure](guides/troubleshooting.md).

## Understand the records

- [Owner loop](explanation/owner-loop.md): how input becomes recorded work and a response.
- [Work ledger](explanation/work-ledger.md): commitments, revisions and evidence.
- [Memory and search](explanation/memory-and-search.md): recall and similar-case discovery.

## Look up an interface

- [CLI commands](reference/cli.md)
- [Configuration and environment](reference/configuration.md)
- [Owner actions](reference/actions.md)
- [Viewer API](reference/viewer-api.md)
- [Public MCP tools, plugin commands and hooks](reference/mcp-tools.md)

## Contribute

Follow [AGENTS.md](../AGENTS.md), then use [contributing](development/contributing.md),
[testing](development/testing.md), [code standards](development/code-standards.md),
[release process](development/release-process.md) and [intent workflow](development/intent-workflow.md).

The [rebuild plan](rebuild/plan.md), [checks](rebuild/checks.md),
[product facts](rebuild/product-facts.md), [report work](rebuild/owner-reports.md),
[replay work](rebuild/window-pipeline.md) and [documentation cleanup](rebuild/docs-cleanup.md)
record implementation evidence and remaining work. They are work logs, not setup instructions.
