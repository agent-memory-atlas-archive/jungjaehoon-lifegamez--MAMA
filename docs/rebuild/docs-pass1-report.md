# Documentation pass 1 report

Date: 2026-09-27. Branch: `rebuild/owner-flow`. No commit.

All 27 D2 pages are present. All 37 retiring files were read before replacement: 35 paths are
removed, while `docs/explanation/architecture.md` and `docs/guides/troubleshooting.md` are rewritten
in place. Current knowledge was checked against the source and carried into the destinations below.
No archive folder was added. `docs/guides/security.md` already occupies its D2 location.

`git rm` was attempted but could not create `.git/index.lock` in this sandbox. The working-tree
deletions are complete and remain unstaged. READMEs, website files, CHANGELOG and TODOS are unchanged.
The pre-existing local `docs/superpowers/` drafts are untouched and excluded from the published-doc check.

## Validation

- Relative-link check: 228 relative links across 39 Markdown/text/HTML files; **0 unresolved paths**. This includes 4 links in unchanged pass-2 files; 114 local superpowers drafts are excluded.
- Checked Markdown inline/reference links and images, HTML href/src attributes, and the llms index.
  Relative paths were resolved from the containing file; fragments were stripped. This is a file
  existence check, not an external-URL or general heading-anchor check.
- Owner action table regenerated from the current core/product registrations and runtime assembly:
  19 owner grants, 19 assembled contracts and 19 matching documented rows, including schema inputs.
- Security preservation check: removing the 10 added onboarding/token lines reproduces the original
  file byte for byte. No other security prose was changed.
- Privacy: 43 authored or retained-scope files scanned with 38 local private-data patterns plus generic credential, email, local-home and platform-ID checks; no matches. Public package identifiers and local listener addresses remain where needed for operation.
- Formatting and syntax: Prettier on the 26 rewritten D2 pages and this report; `git diff --check`, JavaScript/shell syntax checks and version-sync check passed. The preserved security page was not reformatted.
- No product runtime tests or live owner turn were run for this documentation pass. It does not
  establish completion of the owner loop or the fresh-machine onboarding check.

## Code findings reflected in the pages

- Current source setup is documented because the package manifest omits required viewer assets.
- Codex login targets the managed home; owner assembly does not provide an authentication copy source.
- The local plugin manifest still launches the published MCP package; testing the checkout server
  uses its local stdio entry point. Public MCP uses core in process and does not require the OS daemon.
- Replay needs prepared imports and a separate provider key file. The existing product-facts input
  was preserved with a narrow correction from “every token” to onboarding-managed tokens.
- Viewer health/static routes, authenticated data routes and compatibility stubs are distinguished.
- Obsolete version-sync/pre-commit targets were removed, and the retained case error points to the
  new troubleshooting section. Learning links in AGENTS and INTENT point into the new tree.

## Removed paths and retained knowledge

| Removed file                                                      | Current destination for still-valid material        |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| `docs/architecture/package-structure.md`                          | architecture, contributing, release process         |
| `docs/archive/fr-mapping-v1.0.md`                                 | memory and search, intent workflow                  |
| `docs/development/2026-08-26-one-front-team-work-agent-design.md` | owner loop, intent workflow                         |
| `docs/development/2026-09-08-one-mama-autonomy-audit.md`          | intent workflow, testing, release process           |
| `docs/development/developer-playbook.md`                          | architecture, contributing, testing, code standards |
| `docs/development/one-mama-learning-anchor.md`                    | corrections and learning, intent workflow           |
| `docs/explanation/data-privacy.md`                                | architecture, security                              |
| `docs/explanation/decision-graph.md`                              | memory and search                                   |
| `docs/explanation/mama-os.md`                                     | architecture, owner loop                            |
| `docs/explanation/performance.md`                                 | memory and search, testing                          |
| `docs/explanation/semantic-search.md`                             | memory and search                                   |
| `docs/explanation/tier-system.md`                                 | memory and search, testing (no product tiers)       |
| `docs/explanation/work-agent.md`                                  | owner loop, intent workflow                         |
| `docs/guides/cline-backend.md`                                    | backends (supported runtimes only)                  |
| `docs/guides/code-act-sandbox.md`                                 | backends, security (current isolation only)         |
| `docs/guides/codex-backend.md`                                    | backends                                            |
| `docs/guides/configuration.md`                                    | configuration reference, development-memory setup   |
| `docs/guides/deployment.md`                                       | owner setup, release process                        |
| `docs/guides/gateway-config.md`                                   | Telegram, connectors                                |
| `docs/guides/installation.md`                                     | owner setup, development-memory setup               |
| `docs/guides/migration-v0-to-v1.1.md`                             | troubleshooting (data-home separation)              |
| `docs/guides/mobile-access.md`                                    | viewer, security                                    |
| `docs/guides/multi-agent-advanced.md`                             | backends (native children in one owner turn)        |
| `docs/guides/performance-tuning.md`                               | troubleshooting, memory and search                  |
| `docs/guides/procedure-corrections.md`                            | corrections and learning                            |
| `docs/guides/standalone-setup.md`                                 | owner setup, backends, wiki                         |
| `docs/guides/standalone-troubleshooting.md`                       | troubleshooting                                     |
| `docs/operations/entity-substrate-runbook.md`                     | troubleshooting, owner loop, testing                |
| `docs/reference/api.md`                                           | MCP tools, viewer API                               |
| `docs/reference/commands.md`                                      | CLI, MCP tools                                      |
| `docs/reference/configuration-options.md`                         | configuration, MCP tools                            |
| `docs/reference/hooks.md`                                         | MCP tools, development-memory setup                 |
| `docs/tutorials/first-decision.md`                                | development-memory setup, MCP tools                 |
| `docs/tutorials/getting-started.md`                               | owner setup, development-memory setup               |
| `docs/tutorials/hook-setup.md`                                    | development-memory setup, MCP tools                 |

The two rewritten old paths retain package/runtime boundaries in `explanation/architecture.md`
and supported diagnostics in `guides/troubleshooting.md`. Retired feature contracts and unsupported
performance or completion claims were removed rather than copied.

## D2 pages written

| File                                                                             | Lines |
| -------------------------------------------------------------------------------- | ----: |
| [docs/index.md](../index.md)                                                     |    48 |
| [docs/development/code-standards.md](../development/code-standards.md)           |    71 |
| [docs/development/contributing.md](../development/contributing.md)               |    68 |
| [docs/development/intent-workflow.md](../development/intent-workflow.md)         |    62 |
| [docs/development/release-process.md](../development/release-process.md)         |    82 |
| [docs/development/testing.md](../development/testing.md)                         |    89 |
| [docs/explanation/architecture.md](../explanation/architecture.md)               |    72 |
| [docs/explanation/memory-and-search.md](../explanation/memory-and-search.md)     |    74 |
| [docs/explanation/owner-loop.md](../explanation/owner-loop.md)                   |    75 |
| [docs/explanation/work-ledger.md](../explanation/work-ledger.md)                 |    72 |
| [docs/guides/backends.md](../guides/backends.md)                                 |    46 |
| [docs/guides/connectors.md](../guides/connectors.md)                             |    67 |
| [docs/guides/corrections-and-learning.md](../guides/corrections-and-learning.md) |    43 |
| [docs/guides/replay.md](../guides/replay.md)                                     |    59 |
| [docs/guides/reports-and-board.md](../guides/reports-and-board.md)               |    53 |
| [docs/guides/security.md](../guides/security.md)                                 |   151 |
| [docs/guides/telegram.md](../guides/telegram.md)                                 |    59 |
| [docs/guides/troubleshooting.md](../guides/troubleshooting.md)                   |   118 |
| [docs/guides/viewer.md](../guides/viewer.md)                                     |    53 |
| [docs/guides/wiki.md](../guides/wiki.md)                                         |    57 |
| [docs/reference/actions.md](../reference/actions.md)                             |    47 |
| [docs/reference/cli.md](../reference/cli.md)                                     |    55 |
| [docs/reference/configuration.md](../reference/configuration.md)                 |    93 |
| [docs/reference/mcp-tools.md](../reference/mcp-tools.md)                         |    81 |
| [docs/reference/viewer-api.md](../reference/viewer-api.md)                       |    77 |
| [docs/start/claude-code-plugin.md](../start/claude-code-plugin.md)               |    79 |
| [docs/start/owner-setup.md](../start/owner-setup.md)                             |   101 |

## Navigation, evidence and link updates

| File                                                                                                     | Lines |
| -------------------------------------------------------------------------------------------------------- | ----: |
| [.husky/pre-commit](../../.husky/pre-commit)                                                             |    66 |
| [AGENTS.md](../../AGENTS.md)                                                                             |   144 |
| [INTENT.md](../../INTENT.md)                                                                             |   117 |
| [docs/llms.txt](../llms.txt)                                                                             |    33 |
| [docs/rebuild/checks.md](checks.md)                                                                      |   925 |
| [docs/rebuild/docs-cleanup.md](docs-cleanup.md)                                                          |   132 |
| [docs/rebuild/plan.md](plan.md)                                                                          |   121 |
| [docs/rebuild/product-facts.md](product-facts.md)                                                        |    74 |
| [docs/rebuild/docs-pass1-report.md](docs-pass1-report.md)                                                |   132 |
| [packages/mama-core/src/AGENTS.md](../../packages/mama-core/src/AGENTS.md)                               |    79 |
| [packages/mama-core/src/knowledge/case-errors.ts](../../packages/mama-core/src/knowledge/case-errors.ts) |    50 |
| [scripts/sync-versions.js](../../scripts/sync-versions.js)                                               |   243 |
