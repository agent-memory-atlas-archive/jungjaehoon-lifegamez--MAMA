# Documentation and surface cleanup before the rebuild PR

Why: the rebuild (commit `2fb693d75` onward) replaced the product layer, but almost every reader-facing
document still describes the deleted product: `mama init/setup/start/gateway/connector` commands,
Discord/Slack chat gateways, Cline, multi-agent/Conductor, Code-Act, envelopes, the tier system,
workorders, cron/heartbeat, 13 connectors. Four read-only audits on 2026-09-26 checked every doc against
the code (removals confirmed in `packages/*/src`). Owner checks served: all five (a reader who follows
the docs must reach a working owner loop) and the shared-engine goal (core README, second consumer).

Current behavior is recorded in [product facts](product-facts.md): `mama init`, `mama secret`,
`mama daemon`, `mama replay`, `mama status` and `mama stop`; one owner session on the `claude` or
`codex` backend; Telegram owner chat; five source connectors; 19 owner actions; reports, replay and
the GET-only viewer. Onboarding writes secret-free config and connector files plus `auth.env`,
and can write launchd files without starting the service. The public MCP server uses core in
process with its own development-memory database; it does not need the OS daemon.

## D0 — code defects the audits found (fix before the PR)

| #   | Defect                                                                                                                                                                                                                                      | Done when                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| D0a | MCP server read `~/.mama/session-credential`; the daemon writes `runtime/session-credential`; every call refused                                                                                                                            | **Done** `d95975a96` (live call refused before, answered after)                                                           |
| D0b | MCP tools call actions the daemon does not serve: `memory.update`, `memory.checkpoint.save/load`, `source.ingest`, `memory.read:topic` → MCP `update`, `save` checkpoint/ingest, `load_checkpoint`, `/mama:checkpoint`, `/mama:resume` fail | **Done** `ec3a09eba`: public MCP restored in-process (owner decision); live stdio save/search/update/checkpoint/load pass |
| D0c | `packages/standalone/package.json` declares bin `mama-code-act-mcp` → `dist/mcp/code-act-server.js`, which does not exist                                                                                                                   | **Done** `ec3a09eba`                                                                                                      |
| D0d | Viewer auth accepts Cloudflare Access headers from a local peer by presence only (no JWT check); security.md calls this "validated"                                                                                                         | **Done** `b0545603c`: JWT verified (issuer/AUD from the live Access app); owner login passes, forged headers 401          |
| D0e | Settings nothing reads: `MAMA_EMBEDDING_MODEL` in the plugin's `plugin.json` and `.mcp.json`; `/mama:configure` writes `~/.mama/config.json` and offers `--tier-check`; AGENTS.md names `MAMA_PERSONA_NATIVE_TOOLS`                         | **Done** `ec3a09eba` (manifest test pins it)                                                                              |
| D0f | The retired standalone troubleshooting guide advised deleting SQLite `-wal`/`-shm` files (data loss); retained guidance is in [troubleshooting](../guides/troubleshooting.md)                                                               | **Done** `ec3a09eba`                                                                                                      |
| D0g | Leftover folders `packages/desktop`, `packages/core-conformance` (only `node_modules`/`src-tauri`/`.turbo`); migration 030 comments cite a spec that never existed in git                                                                   | **Done** `ec3a09eba`                                                                                                      |

## D1 — first things a reader opens (rewrite)

- `README.md` (keep lines 17-38 and the still-true security lines: `MAMA_AUTH_TOKEN`, `/health`, 127.0.0.1).
- `docs/website/index.html` (copies the README section by section; version badge says 0.52).
- `docs/index.md` (links removed features, no link to INTENT or docs/rebuild).
- `packages/standalone/README.md`, `packages/mama-core/README.md` (ten nonexistent functions, old tree,
  "migrations 001-036"), `packages/mcp-server/README.md` (13 tools listed, 4–5 advertised; needs the
  daemon), `packages/claude-code-plugin/README.md` (update: version, tiers, marketplace path, env vars).
- `CHANGELOG.md`: add an Unreleased section for this branch (latest entry 0.56.0 describes removed
  gateway operations).

## D2 — owner decision 2026-09-27: delete what is not current, reorganise around today's product

No archive folder: a document that does not describe the current product is deleted (git keeps the
history). Everything reader-facing is rewritten into this tree; each page is checked against the code.

```
docs/index.md                         entry: what MAMA is, the two products, where to start
docs/start/owner-setup.md             install, `mama init` onboarding (tokens typed by the owner), launchd, first turn
docs/start/claude-code-plugin.md      development memory: plugin + public MCP server, commands, hooks
docs/guides/backends.md               Claude or Codex, auth per backend, agent.* keys, isolation and credential boundary
docs/guides/telegram.md               owner chat, owner check, attachments, file delivery
docs/guides/connectors.md             connectors.json, roles, per-source credentials, Kagemusha bridge, calendar (gws)
docs/guides/reports-and-board.md      [notify]/[ack] deltas, board turn, 8/13/18 full report, 9-21 reminder
docs/guides/replay.md                 day windows, journal and wiki outputs, live fence
docs/guides/wiki.md                   vault layout, manage.wiki.* actions
docs/guides/corrections-and-learning.md  memory kinds, lessons and preferences, checking a correction survives restart
docs/guides/viewer.md                 pages, local and remote access (Cloudflare Access + origin JWT, token, Host allowlist)
docs/guides/security.md               threat model and defences (rewritten in security P2)
docs/guides/troubleshooting.md        config errors, launchd loops, Telegram silent, connector auth, reading the traces
docs/explanation/architecture.md      packages, data homes, one owner session, host contract, where records live
docs/explanation/owner-loop.md        recognise, attach, answer, report, learn as the code runs them
docs/explanation/work-ledger.md       commitments, revisions, evidence links, assignees
docs/explanation/memory-and-search.md memory records, recall with kinds, source search, lessons injection
docs/reference/cli.md                 mama init | secret | daemon | replay | status | stop
docs/reference/configuration.md       config.yaml keys, connectors.json, environment variables, ignored keys
docs/reference/actions.md             the owner action catalog
docs/reference/viewer-api.md          GET routes, auth, stubs
docs/reference/mcp-tools.md           public MCP tools, plugin commands and hooks, env switches
docs/development/{contributing,testing,code-standards,release-process,intent-workflow}.md
docs/rebuild/*                        work logs (plan, checks, owner-reports, window-pipeline, this list)
```

Delete (content folded into the tree above where still true): every other file under docs/guides,
docs/explanation, docs/reference, docs/tutorials, docs/architecture, docs/operations, docs/archive, and
docs/development/{developer-playbook, one-mama-learning-anchor, 2026-09-08-one-mama-autonomy-audit,
2026-08-26-one-front-team-work-agent-design}.md. Fix every inbound link (AGENTS.md, INTENT.md, READMEs,
CHANGELOG, code comments). TODOS.md keeps only the items that still match INTENT. `docs/superpowers/`
is untracked and never committed; it is left alone (deleting it cannot be undone).

Pass 1 is recorded in the [documentation rewrite report](docs-pass1-report.md): the D2 tree,
retired paths, carry-forward decisions and link check. READMEs, the website, CHANGELOG and TODOS
remain pass 2. Working-tree deletions are unstaged because the session cannot write the git index.

## D3 — onboarding with owner-typed tokens (owner decision 2026-09-27)

`mama init` (TTY only) asks for the backend, the Telegram bot token, the owner chat and user ids and the
connector tokens it needs; tokens are read with echo off and written only to ~/.mama/auth.env (0600),
which the owner agent cannot read (Claude read denies and sandbox denyRead, Codex permission profile).
`mama secret set <NAME>` rotates one. config.yaml and connectors.json carry no secrets: the Telegram bot
token moves out of config.yaml into the environment the daemon reads. The agent never receives, asks for
or writes a token, and both commands refuse to run without a TTY. Done when a fresh HOME is onboarded
end to end with the tokens typed at the prompt and the daemon answers the owner on Telegram.

Implementation (2026-09-27): `mama init` and `mama secret set|list` are wired into the CLI.
Telegram reads `MAMA_TELEGRAM_TOKEN`; any `telegram.token` key fails with the migration command.
Trello reads separate `MAMA_TRELLO_KEY` and `MAMA_TRELLO_TOKEN` values (the carried connector had
expected a combined value). Atomic auth.env writes stage inside the denied runtime directory.
Temporary-HOME tests cover setup, rotation, hidden input and generated launch files. The fresh-HOME
owner login and Telegram answer remain **unverified**; this implementation does not complete D3.

## D4 — every record is traceable end to end

After security P2 (native tool calls traced, tunnel requests logged): follow one owner turn and one
source delta through every store and log by their ids — Telegram update → mailbox row → model run →
tool traces (catalog and native, parent and child runs) → Telegram message ledger / board slot version →
daemon.log lines → the viewer's log route; connector poll → connector index row → delta stimulus →
route line → board turn → report.publish trace. Any hop without a shared id is a defect to fix.

## D5 — rebuild docs that went stale today

- `owner-reports.md`: the calendar "named gap" (restored in `9835c7efc`); eight "today …" sentences
  already fixed by R4–R10 (lines 59, 80-81, 103-107, 136, 148-153, 162-164, 170-171, 172-173); the order
  line marks only R1/R2 done; R10(f) partial result.
- `plan.md`: status line; "four connectors, codex driver" (now five, two backends); board-slot
  instructions listed as dropped but in use; W5/W6/W9/W10 have evidence in checks.md but no status; W10
  "serves no web page"; `deliver.telegram` → `deliver.telegram.file`; link owner-reports and
  window-pipeline.
- `window-pipeline.md`: "C1/C2 still open", "0 spawn_agent", P5 has no result.
- `checks.md`: a back-reference on the W0 "still open" entry.

## Order

D0 (done) → security P2 → external-access detection → D4 tracing check → D3 onboarding → D1 + D2
(delete and rewrite in one pass, so the docs describe the onboarding that exists) → D5 → D6.

## D6 — privacy gate before the PR (owner requirement 2026-09-27)

Before any push: scan the whole working tree, the full git history of the branch (every commit's added
lines and messages) and the PR body for personal names, channel/room/user ids, phone numbers, email
addresses, customer and project names from the owner's business, tokens, keys, credential-shaped strings
and hostnames. Anything found is removed (history rewritten if it is in a commit) and the scan is run
again until clean. The push and the PR wait for the owner's go-ahead. Each item ends with a link check (no link to a deleted file) and the claims in
the new text checked against the code, as in these audits.
