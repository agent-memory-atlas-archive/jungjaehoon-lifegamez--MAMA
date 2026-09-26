# Documentation and surface cleanup before the rebuild PR

Why: the rebuild (commit `2fb693d75` onward) replaced the product layer, but almost every reader-facing
document still describes the deleted product: `mama init/setup/start/gateway/connector` commands,
Discord/Slack chat gateways, Cline, multi-agent/Conductor, Code-Act, envelopes, the tier system,
workorders, cron/heartbeat, 13 connectors. Four read-only audits on 2026-09-26 checked every doc against
the code (removals confirmed in `packages/*/src`). Owner checks served: all five (a reader who follows
the docs must reach a working owner loop) and the shared-engine goal (core README, second consumer).

What is true today, in one place: `mama daemon | replay | status | stop`; one owner session on the
`claude` or `codex` backend; Telegram owner chat only; connectors chatwork, slack, trello, kagemusha,
calendar (gws); 19 owner actions (`runtime/action-surface.ts`); reports (delta routing, 8/13/18 full,
9–21 reminder); replay; viewer on 127.0.0.1:3847 (GET only); config keys `version, agent, database,
logging, telegram, jev, wiki, reports` (others logged as ignored); manual setup with `config.yaml`,
`connectors.json`, launchd `com.mama.server` and `~/.mama/start.sh`. The MCP server holds no database:
it calls the daemon over `~/.mama/runtime.sock`; only the plugin hooks open `~/.claude/mama-memory.db`.

## D0 — code defects the audits found (fix before the PR)

| #   | Defect                                                                                                                                                                                                                                      | Done when                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| D0a | MCP server read `~/.mama/session-credential`; the daemon writes `runtime/session-credential`; every call refused                                                                                                                            | **Done** `d95975a96` (live call refused before, answered after)                                                           |
| D0b | MCP tools call actions the daemon does not serve: `memory.update`, `memory.checkpoint.save/load`, `source.ingest`, `memory.read:topic` → MCP `update`, `save` checkpoint/ingest, `load_checkpoint`, `/mama:checkpoint`, `/mama:resume` fail | **Done** `ec3a09eba`: public MCP restored in-process (owner decision); live stdio save/search/update/checkpoint/load pass |
| D0c | `packages/standalone/package.json` declares bin `mama-code-act-mcp` → `dist/mcp/code-act-server.js`, which does not exist                                                                                                                   | **Done** `ec3a09eba`                                                                                                      |
| D0d | Viewer auth accepts Cloudflare Access headers from a local peer by presence only (no JWT check); security.md calls this "validated"                                                                                                         | **Done** `b0545603c`: JWT verified (issuer/AUD from the live Access app); owner login passes, forged headers 401          |
| D0e | Settings nothing reads: `MAMA_EMBEDDING_MODEL` in the plugin's `plugin.json` and `.mcp.json`; `/mama:configure` writes `~/.mama/config.json` and offers `--tier-check`; AGENTS.md names `MAMA_PERSONA_NATIVE_TOOLS`                         | **Done** `ec3a09eba` (manifest test pins it)                                                                              |
| D0f | `docs/guides/standalone-troubleshooting.md:456-462` tells readers to delete SQLite `-wal`/`-shm` files (data loss)                                                                                                                          | **Done** `ec3a09eba`                                                                                                      |
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

## D2 — new docs the rebuilt product needs

Guides: owner setup on macOS (config.yaml required keys, connectors.json, owner-policy.md, start.sh PATH
and token env vars, launchd, where files land); choosing Claude or Codex (auth per backend, `agent.*`
keys, `codex_cwd` is the shared workspace, forced workspace-write, isolation); Telegram owner chat
(`owner_chat_id`, `allowed_chats`, `owner_user_ids`, attachments, file delivery); connectors reference
(roles, per-source credentials, Kagemusha bridge, calendar via `gws auth login`); reports and board;
replay; wiki; corrections and learning (memory kinds, lessons, restart check); viewer and local API;
owner troubleshooting.

Explanation/reference: the owner loop; the work ledger (commitments, revisions, evidence); memory and
lessons; the host contract for Claude and Codex; the runtime socket and client; the owner action
reference (replaces most of `docs/reference/api.md`); mama-core as a shared engine (public exports).

## D3 — rewrite or update existing docs

| Verdict | Files                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rewrite | guides: standalone-setup, codex-backend, troubleshooting (keep Node/disk/integrity/model sections), standalone-troubleshooting, configuration (plugin; config.json is dead), security (keep localhost-first, secret filter, untrusted wrapping, isolation), gateway-config → Telegram owner chat, mobile-access (short); installation (standalone part) |
| Rewrite | explanation: architecture, mama-os, semantic-search (real weights 0.7/0.3 Gaussian, FTS5 hybrid, e5-large ~560 MB, model fixed), data-privacy (three data stores)                                                                                                                                                                                       |
| Rewrite | reference: api (action catalog; GET-only viewer routes, stubs marked), commands (CLI part), configuration-options, hooks (4 hooks, no UserPromptSubmit, kill switches exist)                                                                                                                                                                            |
| Rewrite | tutorials: getting-started, hook-setup; architecture/package-structure; development: testing, developer-playbook (keep MCP/plugin sections), one-mama-learning-anchor (v7 terms)                                                                                                                                                                        |
| Update  | guides/deployment (drop memorybench, `MAMA_TRUST_CLOUDFLARE_ACCESS`, `mama start`, envelope/workorder notes); tutorials/first-decision and explanation/decision-graph (topic reuse does not auto-supersede; `update` outcomes); development: release-process (checks.md, AGENTS.md release rules, dead bin), code-standards, contributing (pnpm)        |

## D4 — delete or archive

- Delete: guides/cline-backend, guides/multi-agent-advanced, guides/code-act-sandbox,
  explanation/tier-system (keep one line on `MAMA_FORCE_TIER_3` in semantic-search),
  explanation/performance (no measurement behind any number).
- Archive (move to `docs/archive/` with a banner): guides/procedure-corrections,
  guides/performance-tuning (or cut to a VACUUM/ANALYZE note), guides/migration-v0-to-v1.1,
  explanation/work-agent, operations/entity-substrate-runbook (banner: do not drop the tables; case code
  still reads `entity_observations`), development/2026-09-08-one-mama-autonomy-audit,
  development/2026-08-26-one-front-team-work-agent-design. Fix the inbound links.
- `TODOS.md`: archive the items about deleted code; rewrite the five that still match INTENT (member
  canary, artifact flow, provider continuity, Trello/Kagemusha lifecycle, recall-time provenance).
- `docs/superpowers/` (114 files, gitignored, never in git): leave ignored; do not move into the repo.
- Remove the 18 live links to `docs/archive/fr-mapping-v1.0.md`.

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

D0 → D1 → D2 (owner setup, backends, Telegram, connectors, reports first) → D3 → D4 → D5. D4 and D5
can run alongside D1. Each item ends with a link check (no link to a deleted file) and the claims in
the new text checked against the code, as in these audits.
