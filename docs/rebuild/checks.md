# Rebuild check log

One entry per work item: result, evidence, what still fails. 3-5 lines each.

## W0 — 2026-09-25

- Result: met for W0's own check. No owner check (C1–C6) is claimed.
- Evidence (supervisor, outside the sandbox, uncached): root build and typecheck pass; core 112 files/825
  tests, MCP server 13/121 (14 skipped), plugin 11/165, standalone stub 0 tests. The first uncached run
  failed 24 core tests on a half-downloaded embedding model after the reinstall; they pass once the
  model finished downloading.
- Migrations 081–095 applied to a `VACUUM INTO` copy of the dev memory DB: schema 080 → 095, 1,279 decisions
  kept, integrity ok. The original was only read.
- Still open: release/publish jobs would publish the stub standalone if a release tag is pushed. The daemon
  is stopped until the W1 cutover.

## W1 slice 3 — 2026-09-25

- Result: one-owner native session, mailbox delivery/intake, eight-action surface, and owner assembly are implemented; no C1 owner-check claim.
- Evidence: standalone build/typecheck/full suite pass (30 files, 59 tests); root lint passes; the focused core mailbox/native/runtime/action/commitment suites pass (9 files, 144 tests).
- Regressions cover changed-payload refusal, restart payload identity, Codex/Claude action parity, Claude MCP repair, scheduled no-op delivery, serialized `owner:runtime` intake, and embedded `work.create`.
- Still open: Telegram gateway and daemon bootstrap remain slices 4–5; real provider/model turns, receipts, daemon logs, Telegram delivery, and C1 are not verified in this sandbox.

## W1 slice 4 — 2026-09-25

- Result: owner-only Telegram text intake, formatted/split delivery, durable response deduplication, and restart recovery are implemented; no C1 owner-check claim.
- Evidence: standalone build, typecheck, full suite (38 files, 74 tests), and root lint pass; gateway-focused suite is 7 files / 14 tests.
- The gateway submits `telegram:<chat-id>:<message-id>` as the mailbox stimulus identity and never invokes a model; the prompt now carries the carried Telegram formatter contract.
- Still open: the supervisor's daemon cutover and live Telegram/model turns, receipts, clean daemon log, and C1 remain unverified in this sandbox.

## W1 slice 5 — 2026-09-25

- Result: foreground daemon bootstrap, reverse shutdown, native-to-Telegram final delivery, isolation setup, no-op tick, and W1 integration check are implemented; no C1 owner-check claim.
- Evidence: standalone build and typecheck pass; the W1 loader fixture and related tests pass (3 files, 8 tests); root lint passes.
- The exact owner-file shape projects to four enabled connectors, warns once for ignored names without values, and derives the Telegram owner from the single positive numeric allowed chat.
- The full standalone run reaches 41 files / 78 tests; 38 files / 74 tests pass, while four existing IPC tests fail before assertions because this sandbox denies Unix-socket listen with EPERM.
- The cutover commands are below; boot code does not wipe `~/.mama`, and logs emit stage/stimulus ids without message content.
- Still open: supervisor-executed cutover, live provider/model/Telegram behavior, restart equivalence, clean installed daemon log, and C1.

## W1 cutover

```sh
launchctl bootout gui/$(id -u)/com.mama.server
pnpm --dir packages/standalone build
pnpm --dir packages/standalone typecheck
sed -i '' -E '/^[[:space:]]*export[[:space:]]+MAMA_TRIGGER_LOOP[^=]*=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_BOARD_RECONCILE=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_RECONCILE_TASK_CONTEXT=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_STAGE2_WORKORDERS=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_TEMPORAL_RECONCILE=.*/d' ~/.mama/start.sh
rm -f ~/.mama/mama-memory.db ~/.mama/mama-memory.db-shm ~/.mama/mama-memory.db-wal ~/.mama/mama-metrics.db ~/.mama/mama-sessions.db ~/.mama/runtime.sock
rm -rf ~/.mama/connectors ~/.mama/runtime ~/.mama/codex-runtime ~/.mama/workspace
rm -f ~/.mama/logs/daemon.log && mkdir -p ~/.mama/logs
# managed Codex home: keep login and settings (auth.json, config.toml, installation_id,
# models_cache.json) and skills/; wipe thread, session and memory state only
(cd ~/.mama/.codex && rm -rf sessions shell_snapshots tmp thread-writer-locks memories \
  state_5.sqlite* thread_history_1.sqlite* memories_1.sqlite* goals_1.sqlite* logs_2.sqlite* queue_1.sqlite*)
test -f ~/.mama/.codex/auth.json
test -f ~/.mama/config.yaml
test -f ~/.mama/connectors.json
test -f ~/.mama/auth.env
test -f ~/.mama/start.sh
test -d ~/.mama/briefs
test -d ~/.mama/.codex/skills
test -d ~/.mama/.empty-plugins
test -f ~/Library/LaunchAgents/com.mama.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
test "$(launchctl list | awk '$3 == \"com.mama.server\" { print $3 }')" = com.mama.server
for db in ~/.mama/connectors/*/raw.db; do sqlite3 "$db" "SELECT '$(basename "$(dirname "$db")')' AS connector, COUNT(*) AS raw_count FROM raw_items;"; done
sqlite3 ~/.mama/mama-memory.db "SELECT source_connector, COUNT(*) AS indexed_count FROM connector_event_index GROUP BY source_connector ORDER BY source_connector;"
jq -c 'to_entries[] | {connector: .key, poll_cursor: .value}' ~/.mama/connectors/poll-state.json
sqlite3 ~/.mama/mama-memory.db "SELECT stimulus_id, kind, status, attempts FROM mailbox_inputs ORDER BY id;"
sqlite3 ~/.mama/mama-memory.db "SELECT model_run_id, status, model_id, created_at, completed_at FROM model_runs ORDER BY created_at;"
sqlite3 ~/.mama/mama-memory.db "SELECT tool_name, execution_status, failure_code, model_run_id, operation_id FROM tool_traces ORDER BY created_at;"
sqlite3 ~/.mama/mama-memory.db "SELECT commitment_id, current_revision, head_record_id, updated_at FROM commitments ORDER BY task_id;"
jq -c '.entries[] | {key, state, updatedAt, nextChunkIndex, deliveryUncertain}' ~/.mama/runtime/telegram-message-ledger.json
```

## W1 live-run defect corrections — 2026-09-25

- Result: fixed input-sensitive native loop detection, owner `max_turns`/timeout propagation, Kagemusha channel-id mapping, mailbox ACK timing, and hashed source-delta identities.
- Evidence: core loop, mailbox-boundary, standalone config, Kagemusha epoch-ms, source-id, and native-session regressions pass; core/standalone builds and typechecks pass.
- Live cause: Kagemusha timestamps were epoch-ms and the 102-row window was present; bare configured channel ids did not match the namespaced connector key, so all rows were filtered.
- Live cause: native receipt acceptance updated `mailbox_inputs` to `acked` before final delivery; failed native turns now remain claimed/uncertain until reconciliation, while pre-dispatch failures use mailbox retry.
- Still open: full suites are socket-blocked in this sandbox only (`listen EPERM`); no socket workaround or daemon/live rerun was performed.

## W1 source-delta handle correction — 2026-09-25

- Result: source deltas now carry the projected `observationRef` from connector index projection through mailbox payload and rendered stimulus; no C1 owner-check claim.
- Evidence: real connector-runtime fixture with two observations reaches the mailbox and dispatches real `source.read` for both handles; connector and polling tests pass, while socket-backed W1 delivery remains sandbox-blocked by `listen EPERM`.
- Still open: supervisor rerun of the native W1 path and live model/receipt evidence.

## W1 action-contract descriptions — 2026-09-25

- Result: source, work, memory, and graph query input fields now expose concise descriptions with example shapes, including nested fields; no new inputs were added.
- Evidence: core catalog contract test passes all 10 tests and standalone source/work contract tests pass; no C1 owner-check claim.
- Still open: full standalone verification and live model confirmation that the described source handle is selected.

## W1 scheduled producer removal — 2026-09-25

- Result: daemon no longer creates the W1 periodic scheduled no-op or returns a scheduled resource; direct scheduled intake and generic scheduled delivery remain in place.
- Evidence: daemon bootstrap tests pass; the scheduled delivery test remains unchanged but is socket-blocked in this sandbox before its assertions.
- Still open: full standalone/root verification and supervisor confirmation that no scheduled mailbox rows are produced during the live run.

## W1 real-path integration verification — 2026-09-25

- Result: corrected the integration test’s action ledger; no product change was needed.
- Evidence: the real delta payload supplied both observation handles to two real `source.read` dispatches, `work.create` returned a commitment, and all full suites pass: core 113/829, standalone 41/84, MCP 13 files with 121 passed and 14 skipped.
- Cause: the fixture double called `work.create` but never recorded `actionNames.push('work.create')`, so the assertion reported a false stop before creation.
- Still open: live provider/model/Telegram owner evidence and the C1 owner check remain outside this test.

## W1 third live-run recording correction — 2026-09-25

- Result: source-delta policy now records moved work, treats other-system tasks as evidence, admits the owner global/user/connector scopes, and stores bounded final responses in model-run summaries.
- Evidence: focused regressions pass; core 113 files / 831 tests, standalone 41 / 86, MCP 13 files with 121 passed / 14 skipped; build, typecheck, lint, and formatting pass.
- Read-only live state remains unchanged: 12 model runs, one historical scope denial, and one historical graph-visibility denial; the daemon stayed stopped.
- Still open: supervisor rerun of the native W1 path and live provider/model/Telegram receipt and delivery evidence.

## Known flaky (carried from the archive)

- `mama-core tests/knowledge/graph-roundtrip.test.ts` "browses visible edges in bounded pages" failed
  once in a full parallel run (cursor expected null) and passed 3/3 alone; no knowledge code changed.

## Replay Task 1 — 2026-09-25

- Result: external owner policy loading, stable citation standing text, and the owner work contract fields are implemented; no C1 owner-check claim.
- Evidence: absent/present boot logging, exact-byte fingerprint reload, policy-layer ordering, changed-policy thread rotation, and contract traversal pass; root full suite passes 41 standalone files / 96 tests.
- Still open: replay collection, source-time read ceilings, ordered delivery, live connector fence, and real provider/model owner evidence remain in later tasks.

## Replay Task 2 — 2026-09-25

- Result: source event time now reaches decision and assignment projections, history exposes it, readWork filters by it, and replay writes reject missing/future event times with named errors.
- Evidence: commitment read/write focused suites pass 27/27; root full suite passes 113 core files / 833 tests and the standalone replay gate passes before any knowledge write.
- Still open: the active replay ceiling is only exposed as a session fact here; Task 4 must populate it through the replay runtime, and C1/C2 live verification remains open.

## Replay Task 3 — 2026-09-25

- Result: collect-only Kagemusha/Trello import modules, bounded manifest/fence, read-only source DB, pending projection drain, and R2 direct-channel continuity are implemented; no mailbox, model, commitment, or source-delta path is called.
- Evidence: standalone full suite is 44 files / 105 tests; replay tests cover equal-time keyset pages over 5,000 rows, numeric Chatwork mappings, unmapped-row counts, Trello 1,000-plus paging, stable action IDs, read-only opening, and idempotent reruns.
- Read-only real-data dry-run at the recorded fence mapped kakao 3,737/3,737, line 183/183, telegram 59/59, airbnb 0/0, slack 188/188, chatwork 149/149; every origin had zero unmapped rows.
- Still open: the approved import has not been run against MAMA state, and Trello API actions were not fetched; this turn wrote no `~/.mama`, `~/.claude`, or `~/.kagemusha` data.

## Replay Task 4 — 2026-09-25

- Result: the inclusive replay source ceiling now flows from active delivery through native and dynamic IPC/MCP session facts into dispatcher allowances, source readers, raw queries/cursors, graph visibility, provenance, and Task 2 work-write validation.
- Evidence: core full suite is 116 files / 837 tests; standalone full suite is 44 files / 105 tests; regressions cover source/list/read/history, cursor-ceiling mismatch, graph/observation and provenance visibility, native action calls, and dynamic socket facts.
- The standalone Vitest harness uses a single fork because concurrent native SQLite teardown otherwise exits 139 after passing replay tests; the serialized full run exits 0.
- Still open: ordered model replay, real owner/provider turns, receipts/delivery, and C1/C2 remain intentionally outside Tasks 3–4.

## Replay Task 5 — 2026-09-25

- Result: metadata-only source catalog, KST half-day ordering, one delta per connector/channel/window, replay ceiling, 500-ref preflight, append-only ledger, and atomic crash cursor are implemented.
- Evidence: replay catalog/feeder tests cover global and group ordering, source-time occurrence, cursor restart, cap failure before acceptance, and uncertain delivery stop; mailbox cap and source-delta tests pass.
- Files: `packages/standalone/src/replay/{replay-source-catalog,replay-feeder,replay-cursor,replay-ledger}.ts`, `stimulus-delivery.ts`, `packages/mama-core/src/runtime/mailbox.ts`, and their focused tests.
- Still open: the supervisor must run the real provider replay and inspect native receipts/model writes; no `~/.mama` state was written here.

## Replay Task 6 — 2026-09-25

- Result: `mama replay` boots the owner runtime and feeder only, logs `replay collectors: disabled`, leaves the configured live connector set unchanged, and writes every enabled live poll cursor to fence T after settlement; Kagemusha live messages use `(created_at,id)` keyset pages with no 5,000-row limit.
- Evidence: daemon replay isolation, poll-fence, and 5,001-row Kagemusha tests pass; R1/R2/R4/R5 are encoded, and no overlap report or collector-set rewrite is present.
- Files: `packages/standalone/src/cli/commands/{daemon,replay}.ts`, `runtime/connectors.ts`, `connectors/kagemusha/index.ts`, `cli/index.ts`, plus replay/runtime tests.
- Still open: only a supervisor run can prove T→now live polling, Telegram startup, clean daemon log, native receipt, and C1/C2.

## Replay Task 7 — 2026-09-25

- Result: counts-only `verify-september.mjs` checks Kagemusha/raw and Trello coverage, ledger/cursor order, event-time revisions, task-shape fields, and resolvable citations; the collect-only import runner and Trello board/day manifest support the operator path.
- Evidence: the verification fixture passes with zero coverage/order/null-time/unresolvable-citation differences; standalone full suite is 47 files / 117 tests and core full suite is 116 files / 838 tests.
- Read-only dry run at the current Kagemusha fence found T=`1790313098001`, 4,322 mapped source rows, 50 KST half-day windows, 326 message deltas, and zero unmapped rows. Trello API history was not fetched, so final replay deltas are `326 +` the Trello board/window groups shown by replay preflight.
- Still open: import/replay, final counts-only verification, and real owner C1/C2 confirmation remain supervisor work.

## September replay — supervisor runbook (R1–R5)

The implementation writes raw/index data during import only. Replay is the owner runtime plus feeder; it does not start live connectors or Telegram. The current read-only dry run predicts 25 KST daily turns through T=`1790327903001`, 5,670 source observations (4,341 mapped messages, 74 parsed feedback calls, 1,255 Trello rows), and a maximum daily stimulus of 451 refs; the 500-ref ceiling remains sufficient.

1. Stop the launchd daemon before touching the disposable testbed:

   ```sh
   launchctl bootout gui/$(id -u)/com.mama.server
   ```

2. Wipe the same W1 cutover state, keeping credentials/configuration, briefs, skills, and launchd files. The exact keep-list commands are the W1 cutover block above; the destructive portion is:

   ```sh
   rm -f ~/.mama/mama-memory.db ~/.mama/mama-memory.db-shm ~/.mama/mama-memory.db-wal ~/.mama/mama-metrics.db ~/.mama/mama-sessions.db ~/.mama/runtime.sock ~/.mama/report-slots.json
   rm -rf ~/.mama/connectors ~/.mama/runtime ~/.mama/codex-runtime ~/.mama/workspace
   rm -f ~/.mama/logs/daemon.log && mkdir -p ~/.mama/logs
   (cd ~/.mama/.codex && rm -rf sessions shell_snapshots tmp thread-writer-locks memories \
     state_5.sqlite* thread_history_1.sqlite* memories_1.sqlite* goals_1.sqlite* logs_2.sqlite* queue_1.sqlite*)
   ```

   Re-check that `~/.mama/.codex/auth.json`, `config.yaml`, `connectors.json`, `auth.env`, `start.sh`, `briefs/`, `.codex/skills/`, and the launchd plist still exist. Do not print `config.yaml` or credentials.

3. Build and run collect-only import. Supply Trello credentials through the environment; the runner never prints them:

   ```sh
   pnpm --dir packages/standalone build
   TRELLO_API_KEY="$TRELLO_API_KEY" TRELLO_TOKEN="$TRELLO_TOKEN" \
     node scripts/replay/import-september.mjs \
       --mama-db ~/.mama/mama-memory.db \
       --raw-root ~/.mama/connectors \
       --connectors-config ~/.mama/connectors.json \
       --manifest ~/.mama/runtime/september-import-manifest.json
   ```

   The output is counts only, including feedbackRows and unmappedFeedbackRows. Import must leave mailbox, model-run, commitment, tool-trace, and source-delta counts unchanged; it drains raw projection queues and records the exclusive fence T in the manifest.

4. Run replay. This is the only command that opens the owner runtime and feeder; it does not start live connectors or Telegram:

   ```sh
   node packages/standalone/dist/cli/index.js replay
   ```

   Watch progress without exposing contents:

   ```sh
   tail -f ~/.mama/logs/daemon.log | rg 'replay|stimulus'
   jq '{nextWindowStartMs, currentWindow: (.currentWindow.deltas | length)}' ~/.mama/runtime/september-replay-cursor.json
   jq -s 'group_by(.status) | map({status: .[0].status, count: length})' ~/.mama/runtime/september-replay-ledger.jsonl
   ```

5. After a crash, do not delete the cursor or ledger and do not manually re-send a delta. Stop/restart the same replay command; it reuses the deterministic stimulus IDs and waits for already-admitted rows. A `dead` or `uncertain` mailbox/native state stops replay loudly and requires receipt reconciliation before resuming.

6. Finish only after the cursor reaches T and replay exits successfully. The replay command writes T to every currently enabled connector cursor without changing the connector configuration. Then start the normal daemon so live polling covers T→now and Telegram starts normally:

   ```sh
   jq '.nextWindowStartMs' ~/.mama/runtime/september-replay-cursor.json
   jq -c 'to_entries[] | {connector: .key, poll_cursor: .value}' ~/.mama/connectors/poll-state.json
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
   ```

7. Verify counts and order after replay:

   ```sh
   node scripts/replay/verify-september.mjs \
     --kagemusha-db ~/.kagemusha/kagemusha.db \
     --mama-db ~/.mama/mama-memory.db \
     --raw-root ~/.mama/connectors \
     --manifest ~/.mama/runtime/september-import-manifest.json \
     --ledger ~/.mama/runtime/september-replay-ledger.jsonl \
     --cursor ~/.mama/runtime/september-replay-cursor.json \
     --report-slots ~/.mama/report-slots.json \
     --wiki-root "$WIKI_ROOT"
   ```

   Set `WIKI_ROOT` to the configured `vaultPath/wikiDir` root without printing the owner config. The counts-only result now includes board slot count and latest-update days, wiki page count, lesson count, and lesson provenance count.

   A nonzero exit means at least one count or invariant differs. Finally send the real owner Telegram C1/C2 questions, retain the native receipt/daemon log/DB read-back, restart the daemon, and ask both questions again; those live owner checks are not claimed by the automated script.

## Replay Task 8 — 2026-09-25

- Result: carried agent-written board/wiki stores are wired into the owner catalog and viewer; replay now admits one cross-channel KST daily stimulus with bounded message text, current-work digest, feedback observations, and an end-of-window four-record instruction.
- Evidence: the carried report/wiki assertions pass (a one-slot update is `report.publish` with one slot; the new `report.update` duplicate and the unused Obsidian CLI action were removed at review); replay, importer, verification, viewer-record, and native stimulus tests pass; read-only dry run is 25 windows/turns, 5,670 observations, max 451 refs, and 50 accepted/settled ledger entries.
- Verification: `verify-september.mjs` checks message/feedback/Trello coverage, cursor/order/dead/uncertain state, board snapshot/update days, wiki page count, lesson count/provenance, event-time task shape, and citations.
- Still open: the collect-only import/replay and real owner/provider/Telegram receipt run remain supervisor work; no `~/.mama`, `~/.claude`, or `~/.kagemusha` state was written here.

## September replay run log

- 2026-09-25 run 1 stopped at the first accept (feeder compared a mailbox row number with the stimulus
  id; fixed in bef473b37). Run 2 stopped in window 2 because the feeder's 60-second settle deadline
  killed a healthy turn (fixed in 74c1e49f2). The interrupted delivery (mailbox row 17) was marked
  uncertain; its model run made only reads (source.read 18, work.list 2, memory.search 2, graph.query 2,
  no writes), so the row was returned to pending and its native delivery record removed for
  re-delivery (testbed, supervisor, recorded here).

## Replay delta batch reads and native bridge call cap — 2026-09-25

- Result: `source.read` now accepts one `observationRef` or up to 500 `observationRefs`; each batch item keeps bounded content, replay ceiling, grant checks, and a per-ref error.
- Result: the host bridge no longer counts calls or applies the emergency cap; the identical-call signature guard and configured turn timeout remain.
- Evidence: full root suite passed — core 116 files/838 tests, standalone 47/119, MCP 13 files with 121 passed/14 skipped, plugin 11 files/165 tests; typecheck, lint, and format check passed.
- Still open: the stopped replay and live owner/provider turn were not rerun here; no `~/.mama`, `~/.claude`, or `~/.kagemusha` state was written.
- Run 3 stopped at delta 32: 50 refs read one call each, aborted by the core 50-call emergency cap before
  any write (model run: source.read 50, no writes). Fixed with batched source.read and the cap removed;
  row 32 returned to pending for re-delivery (testbed, supervisor).

## W10 — 2026-09-25

- Result: the carried Tasks drawer now loads the archive-compatible task detail path and renders one event-time-ordered History entry per revision, including summary, reasoning, and cited observations.
- Evidence: standalone FULL suite is 52 files / 137 tests, core is 116 / 838, MCP is 13 passed files / 121 passed and 14 skipped tests, plugin is 11 / 165; forced build, typecheck, lint, focused API tests, and the component render test pass.
- Data path: operator tasks request `work.list(history: all)` and add `commitment_id`; drawer detail reads `work.show`, `graph.query(derived_from)`, and bounded `source.read` slices, projecting event-time Created/Updated and source channels/observation ids.
- Still open: supervisor replay/live owner C1/C2 evidence remains outside this viewer change; the model cache remained exactly 561768762 bytes after the full suite.

## Action MCP door moved into standalone — 2026-09-25

- Result: the owner agent's action MCP adapter is standalone's own `src/runtime/action-mcp-server.ts` (built to `dist/runtime/action-mcp-server.js`); standalone no longer depends on `@jungjaehoon/mama-server`. The owner pointed out that the public MCP server (Claude Code development memory) is a separate product unrelated to MAMA OS; the engine carry (03da2c6fd) had pulled it in with the archive.
- Evidence: core 838, standalone 232 (archive handleRequest unit tests carried), mcp-server 121, plugin 165 passed; the built adapter answers `initialize` over stdio; `resolveActionServerPath()` points at standalone's dist for both backends (Claude MCP config and Codex `mcp_servers` read the same file).
- Still open: `packages/mcp-server` and the plugin keep the archive's carried state, in which the public server calls the daemon socket (`~/.mama`) instead of its own `~/.claude` database. That mixes the two data homes and must be fixed before any mcp-server release; it is outside the owner-flow work.
- 2026-09-25 day-window run: stopped after window 4 settled to ship the standalone action MCP door and the
  wiki wording fix (the agent read "publish wiki pages for cases that changed" as "no page changed" on an
  empty wiki). Window 5's turn was interrupted after writes (work.revise 2, work.create 2, memory.save 1);
  mailbox row 5 (claimed/accepted) was returned to pending and its native delivery record removed so the
  whole day is re-delivered; the agent resolves against existing work before writing (testbed, supervisor).
- 2026-09-25 19:31 KST: stopped after window 9 settled because the daemon's Codex home (`~/.mama/.codex`,
  a separate free-plan account) had used 13% → 79% of its 30-day limit in nine windows (~7% per window).
  Window 10's turn had made no action calls; row 10 was returned to pending. Resume after the owner logs
  the daemon's Codex home into an account with headroom.
- 2026-09-25 ~19:55 KST quality check after window 10: task titles follow the owner title format with
  stage and source time; board slots are grounded; 10 lessons come from the owner's own Telegram
  corrections. Two defects: the board file `~/.mama/report-slots.json` was outside the wipe list, so two
  archive-era slots (taskBasis, next_actions) survived; and wiki pages were thin day deltas that replaced
  the page (plus one catch-all page). Fixed: wipe list, and the window/standing instruction asks for one
  page per case rewritten as its whole running history.
- 2026-09-25 ~20:00 KST: owner asked to switch the owner agent to effort max and continue with the
  corrections. Stopped after window 11 settled (row 12 had dispatched but made no action calls; returned to
  pending), set `agent.effort: max`, removed the two archive-era board slots, and resumed with the viewer
  served during replay (3ee5ebfb8) and the cumulative wiki instruction (704b67c03). Windows 1–11 ran at low.
- 2026-09-25 20:30 KST: stopped cleanly after window 12 (max). Resumed with 1b7c603e9 (compact lines),
  ba3f5e7ae (status vocabulary, owner connector-wide read), 17eac0595 (channel names, Trello lines, whole
  messages, in-window duplicate check). The owner asked that the agent fix out-of-contract statuses itself,
  so one owner message was enqueued (mailbox row 13, occurredAt 9/13 00:00 KST) before window 13. Baseline:
  revisions with off-contract (free-text Korean) status touch 29 / 46 / 14 / 2 commitments
  (waiting / in progress / done / merged duplicate).
- 2026-09-25 20:52 KST: window 13 (9/13, max) aborted "without progress" after 5 min of reasoning-only
  activity (Codex completed a reasoning item every ~10 s); replay stopped on the uncertain row as designed.
  The turn had made reads only (report.read 5, graph.query 1, memory.search 1). Fixed in 79f32a954
  (reasoning items refresh the idle timer); row 14 returned to pending; resumed. The owner status
  correction (row 13) had completed: all latest statuses are in the contract (0 off-contract).

## Window pipeline evidence and review — 2026-09-25

- Artifacts (testbed only, business content): `~/.mama/runtime/measurements/2026-09-25/` —
  `window-0902-lines.txt` (mailbox row 2 rendered as compact lines), `hand-simulation-0902.md`
  (supervisor gold proposal, 10 movements, owner confirmation pending), `codex-step-timings.json`
  (per-request time/input/reasoning/output from every replay Codex session),
  `jev-archive-pipeline-0902-{queue.md,plan.json}` (archive `backfill.mjs` run with FROM/TO on 9/2,
  a measurement copy with a metadata shim and an external model cache; not in the repo).
- Numbers: agent record for 9/2 = 9 revisions / 8 items, 3 items for 2 deliverables, 1 wrong project
  tag, 1 stale state, 5 missed movements. Archive Jev run: 144 conversations → 130 after its text
  dedup → 95 chunks; 84 pair verdicts in 1.2 s; 30 chunks attributed in 1.6 s; bands A 10 / B 3 / C 2
  / D 15; the non-deliverable owner work fell to D. Subagent use: every replay session's tool calls
  are `exec` only (0 `spawn_agent`).
- Codex adversarial review of window-pipeline.md (read-only, gpt-5.6-luna max) applied: no verbatim
  port of archive logic that judges in code (first-80 dedup, card propagation, length filters); Jev
  batch failure stops as incomplete; the low band is "unresolved", shown in full and measured for
  promotion; subagent writes checked by trace, not blocked; candidates are the as-of universe; P5
  fixed to three arms on one snapshot with owner-confirmed labels. Added P0 (progressive work.list):
  68 items = 62k characters current / 165k with history per call.

- P0 implemented: `work.list` now exposes overview/items/detail over `knowledge.readWork`, with
  bounded 25/50 pages, filter-bound read-version cursors, four-id detail, basis/history and text
  continuation. Evidence: standalone full suite 67 files / 376 tests; viewer routes now dispatch items/detail.
- P1 implemented: typed Jev client carries configured key/vocabulary paths, retries 429/529 and
  raises ref-bearing incomplete batches; `jev.keyFile` and `jev.vocabFile` default under the owner
  home without logging key contents. Evidence: injected-fetch success/retry/incomplete tests pass.
- P2 implemented: queue generation keeps source identity only, asks Jev for adjacent chunking/relevance/
  candidates/duplicate pairs, uses as-of open+closed work and Trello time/embedding candidates, and
  surfaces missing verdicts with observation refs. Evidence: injected Jev/embedder queue tests pass.
- P3 implemented: replay deltas carry the queue and stimulus renders A/B/C, suspected duplicates and
  unresolved sections with complete KST lines; replay feeder and source-catalog tests pin the payload
  and renderer. Evidence: replay/runtime targeted tests and the full standalone suite pass.
- P4 implemented: standing/window instructions require queue planning, direct `spawn_agent` proposals,
  owner verification/writes, and trace-based child-write checks in `verify-september.mjs`. Live Jev,
  daemon, replay and live subagent trace runs were intentionally not performed under the brief.

## Window pipeline implementation review — 2026-09-25

- Codex implemented P0–P4 in worktree rebuild/window-pipeline (standalone 376 tests). Supervisor review
  fixed: question wording moved back into code as in the archive (the owner vocabulary notes travel as
  state.note; Codex had required note keys the owner file does not have); candidate questions now name
  their candidate (all were identical); adjacent pairs batched per channel and pooled; embeddings cached
  once per window; work candidates narrowed to embedding top-8 plus exact hints; Trello card facts built
  as of the window end (they read later activity) and from the imported action shape (data.card,
  listAfter; none were built); no default 'pending' in the digest; the Jev request body carried the whole
  owner vocabulary as `vocab`, which the API rejected with HTTP 400 — removed (the archive sent model,
  state, questions only).
- Live 9/2 queue (read-only DB, real Jev; `queue-0902-p2.json`): 163 lines in 12 s; all 10 hand-simulation
  movements land in A, B or C. With the archive pair question ("same single work item?") C held 52
  mostly single lines; asking whether B continues A's topic gave A 7 / B 4 / C 17 / unresolved 10.
- P4 additions (relations, provenance, viewer source text, daily journal, Home.md-first wiki, no host
  index) implemented with tests; standalone 378 tests.

## Replay restart on the window pipeline — 2026-09-25 22:40 KST

- Owner decision: stop the running replay (old input, effort max, 27–49 min per window) and restart
  from 9/1 on the merged window pipeline (c57e32bbc) at effort high. Testbed wiped per the runbook
  (measurement artifacts kept), the rebuild wiki folder emptied, import re-run: kagemusha 4,424,
  feedback 75 (2 unmapped), trello 1,290, fence T 1790329110001 (same as before). The 9/1–9/2 windows are
  compared with the hand-simulation gold before continuing.
- 2026-09-25 23:48 KST: window 9/8 stopped on an uncertain row — the stimulus (1.24M characters) exceeded
  the Codex input limit because suspected-duplicate pairs each carried all window refs (fixed in the
  commit after this entry's predecessor, "suspected duplicates carry no window refs"). Windows 9/1–9/7 had
  run at 4–13 min each. Mailbox row 8 (never delivered: the turn failed before any action) was removed
  with its refs, delivery record and seen refs, and the cursor's accepted entry cleared, so the window is
  re-admitted with the new payload (testbed, supervisor). The owner policy gained the [청구] tag rule.
- 2026-09-25 23:55 KST: resume refused by the cursor identity guard — the owner changed the policy file
  ([청구] tag rule), so the policy fingerprint differed. As an owner-made policy change, the cursor's
  policyFingerprint was set to the new file's sha256 (edba0da6… → f7686069…); windows 9/1–9/7 remain
  recorded under the old fingerprint in the ledger history.
- 2026-09-26 00:10 KST: the re-admitted 9/8 row failed with "no rollout found": the rejected turn's thread
  had been saved at thread/start without a rollout. Fixed in 3b39c3f55 (an explicitly rejected first turn
  forgets its thread); the stale registry file was removed and the replay resumed on row 9 (pending,
  one attempt, no action calls).
- 2026-09-26 00:56 KST: one Jev HTTP 500 while building the 9/11 queue stopped the replay as designed
  (incomplete, before admission; nothing to reconcile). The client now retries 500/502/503 like 429/529.
  Windows 9/1–9/10 done; 9/8 15.6 min, 9/9 12.5 min, 9/10 20.9 min.
- 2026-09-26 01:36 KST: stopped cleanly after 9/12 (9/10 20.9 min, 9/11 26.8 min, 9/12 10.5 min) to apply
  7408b73fc (current revision in the digest and candidates, so a window need not re-read every item with
  work.show before writing). Output now goes to ~/.mama/logs/daemon.log, which the viewer's log tab reads
  (config logging.file pointed there; it only fed the viewer and pointed at an unwritten mama.log).
- 2026-09-26 02:05 KST: stopped cleanly after 9/14 (26.2 min; 9/13 1.2 min) to apply 2535bdfae
  (orchestrated windows with child-written lanes, receipts and changedSince read-back; manage.wiki.update;
  human-readable board/wiki without ids). The owner policy's id rule was scoped (board/wiki prose, ids on
  request), so the cursor policy fingerprint moved f7686069 → 48729f27.
- 2026-09-26 02:17 KST: journal audit, 9/1–9/14 against the ledger (revisions grouped by source-event
  day). Every item that moved on a day is named in that day's journal, but the content is gone: 214
  revisions, 0 of the 36 source times in the ledger appear in any journal, 9/10 covers 27 changes in 984
  characters (the archive's 9/10 was 6.4 KB), several items per clause. The ledger has it: each revision's
  latestEvent states who, when and what (average 89 characters), and the items read-back returns it as
  latest_event. Cause: the journal instruction asked only for "what moved per project". The standing text
  and the window instructions now ask for one entry per moved item from latest_event (who, source time,
  what it contained, what is awaited next), never several items in one clause. 9/15 (orchestrated, old
  journal line) is sentence-style but still folds six submissions into one clause. Replay stopped cleanly
  after 9/15 (watcher on the cursor's settled state). 9/1–9/14 are being rewritten by the owner agent from
  work.list asOf=<day end> changedSince=<day start>, source reads capped at the 9/14 end (owner request
  through the mailbox in replay mode, no outbound reply). Still failing: an owner-admin notice seen in raw
  never became work (judgment, not journal).
- 2026-09-26 02:30 KST: the owner agent rewrote 9/1–9/14 in 11 min (three children by date range, main
  reconciled against changedSince). Re-audit: every moved item named on its day (0 missing), ledger
  source times present (35/39), no ids in any body, later dates only as that day's stated deadlines or
  schedules (no future facts); 9/10 now 23 dated entries with actor, files, feedback points and next wait,
  plus a judgment section. Remaining: style differs between children (bold headers vs plain lines, the
  English "unconfirmed" in prose), entries are not time-ordered within a section. Correction of an earlier
  claim: the <place-1> 9/16–9/19 reservation is not in the ledger (13 <place-1> items, none a reservation); like
  the health-insurance notice it is a recording miss in raw, not a journal omission. Replay resumed at 9/16
  on the new journal instruction.
- 2026-09-26 02:53 KST: window 9/16 took 22.3 min on the one-entry journal rule. Split (main rollout
  timestamps): queue 0.5, main listed the whole ledger again 1.0 (two pages, 100k characters, although
  current_work carries every revision), plan and three dispatch messages 3.0, children 3.5–5.5 in
  parallel, main read-back and wiki fixes 3.5, main alone writing the journal ~2.5 (10.9 KB), then board.
  Main context 151k of 258k tokens per call. Changed: the main creates the day's journal with one heading
  per lane before dispatch, each child adds its items' entries under its heading (manage.wiki.update,
  re-read on a version conflict), the main writes only the judgment section and fills entries missing
  from the read-back; and it does not list the whole ledger when current_work already carries it.
- 2026-09-26 03:44 KST: window 9/17 took 24 min (9/16: 22). Children writing their journal entries works
  (9/17: 23/23 items, 16/16 ledger times, no loss from concurrent edits) but lengthened the children
  (6.5–9 min vs 3.5–5.5); dropping the full ledger listing saved 1 min before dispatch. The main's
  post-children phase stayed at 13 min: it re-read pages it had just written (19k–41k characters, three
  times), listed changedSince four times and published the board twice. Code gap: manage.wiki.update
  returned no content version, so any second edit of a page was refused as stale and forced a whole-page
  read (seen on the journal and a project page). It now returns contentVersion, and a stale refusal
  carries the current version and the current text of the sections being edited. 9/18: 24 min, stopped
  at its boundary to apply this.
- 2026-09-26 04:40 KST: windows 9/19 7 min (1 item), 9/20 14 (7), 9/21 19 (12), 9/22 12. Per item 9/21 is
  no faster than 9/17 (23 items, 24 min). The main's rollout shows refused calls, each a 20–60 s round:
  seven in 9/21 alone. Across windows: wiki section not a heading line or not on the page (7; the refusal
  did not name the page's headings, so the agent re-read the page), an unavailable reference (6; the
  agent had dropped the last character of an observation id and the refusal did not say which reference),
  items limit over 50 (2), a channel name passed as the connector (2, left as designed: grants are not
  echoed). The section refusal now lists the page's headings (the heading pattern moved from the schema
  to that check) and the reference refusals name the caller's own kind and id.
- 2026-09-26 05:10 KST: replay complete (25 windows; 9/23 6 min, 9/24 9, 9/25 9). Refused calls in
  9/23–9/25: 3 in total (9/21 alone had 7), and the reference refusal now names the truncated id.
  Journals 9/16–9/25: every moved item present, ledger source times 116/119; 9/15 still has the old
  style (4/17). verify-september: import 4,349/4,349 and Trello 1,290/1,290 with 0 differences, order
  and cursor clean (the one duplicate and one uncertain delivery are the 9/8 incident above), 419
  revisions all with event time, 23 lessons all with derived_from, 233 child writes all tied to a model
  run, 45 wiki pages. Failing: 9 unresolvable citations, all in commitment sourceRefs, all observation
  ids with the last character dropped by the agent; links are checked by core but sourceRefs were stored
  unchecked. work.create/work.revise now refuse a sourceRef that names no observation (the product owns
  the observationRef meaning; core keeps sourceRefs opaque). The 9 stored refs remain in history.
- 2026-09-26 10:16 KST: owner C1/C2 on Telegram against the live daemon (launchd, same Codex thread as
  the replay's end; boot and log clean). C1 "who is working on what" answered in 2 min 50 s from
  work.list (70 open: 27 in progress, 11 review, 32 pending), listing about 15 recently confirmed items;
  33/33 cited commitment and observation ids resolve. Against Kagemusha's open tasks of 9/24–9/25 it
  covers <asset-10> EX/BC/TF, <asset-13>, <asset-11> ST, <asset-8>, <asset-9>, <asset-5> AR/SSR1,
  <asset-7> SSR1/2, <asset-16>; it omits <asset-12> BC and <asset-11> EX submissions (both in the ledger)
  and the lodging items. The 9/21 order-volume notice is not work in the ledger: the 9/21 agent put it in
  the wiki (PROJECT2019 page, journal), Kagemusha made it a task. C2 "how did <asset-1> SSR1 go"
  answered in 56 s: done, client FIX, month-end delivery on 9/17 — matches the 7-revision history; but
  it merged two rounds (the 9/11 side-hair fix is described as the 9/15 second draft), cites the 9/11
  messages for it, and skips the 9/14 feedback round. Answers carry ids in <code>; owner to decide.
- 2026-09-26 10:40 KST: what an owner correction can and cannot change (code and data read). A
  correction lives in one of three places. (1) The session: applies at once, lost at a thread reset —
  9 resets in the last day (every standing-text or policy change and each daemon start). (2) A lesson
  (memory.save kind lesson): durable, but the host never puts lessons into a turn; the agent must search
  for them, and of 41 memory.search calls in the replay only 2 looked for corrections. The standing text
  asks for a lesson only at a replay window's end, not in a chat turn. (3) ~/.mama/owner-policy.md:
  injected into every session as a system layer and part of the session identity, but no action writes
  it — only a person. Kagemusha, by contrast, searches its lessons with each incoming message and injects
  the top 3 (<brain_lessons>, "lessons, not facts") plus a startup summary, and records whether they
  were applied. Of the 23 replay lessons, 6 repeat one correction (feedback PDF → Excel in the existing
  template → the file itself to Telegram): no owner action reads attachments, writes files or sends a
  document, so no correction can make it happen (Kagemusha's agent built scripts for it in its home and
  sends documents). Correctable by the owner once a correction persists: answer scope and stale items
  (C1), listing each feedback round (C2), what counts as work (lodging reservations, admin notices, the
  order-volume notice), journal and board style. Ids in Telegram answers need the standing text changed
  too: it demands ids, and the owner policy is the lower-priority layer.
- 2026-09-26 11:00 KST: why lookups are slow and inaccurate (C1/C2 rollouts; tool results return in
  under 0.3 s, so the gaps are the model). Slow: (1) the live chat continued the replay's Codex thread,
  so every step carried 136k–208k tokens and the first step had no cache hit (14 s); an automatic
  compaction hit mid-turn on a third question (226k → 92k). (2) C1 read the whole ledger in three
  pages (84k characters), then re-read the open items one status at a time (four calls, 25k), because
  status takes one value. (3) Wasted calls: work.list text "<asset-1> SSR1" returned 0 (the title
  is "<asset-1>⑥*SSR*イラスト1"; the filter is a plain substring), graph.query refused kind "work",
  and work.list view=items accepted an ids argument it ignores and returned an unrelated 13k page.
  Inaccurate: (1) the lookup — substring text misses the owner's phrasing (spaces, ⑥, Korean vs
  Japanese names) and memory.search ranked a similarly named other item (<asset-7> SSR1) first.
  (2) C2 called work.show without history, then rebuilt the chronology from provenance fragments and
  merged the 9/11 side-hair fix into the 9/15 second draft although it had read the 9/15 messages; r6
  carried the right evidence. (3) 40 of 70 open items (57%) had no event after 9/18; the ledger has no
  closure for work that went quiet, so a current-work answer must pick and drops real ones.
- 2026-09-26 11:40 KST: owner-reports R1+R2 (Codex implemented, verified outside the sandbox: runtime
  46/46, typecheck clean). The owner-answer line no longer demands commitment/observation handles;
  answers, reports and notifications carry no ids and the reads stay in the traces. The replay-only
  lesson clause became one rule for every turn (save an owner correction as a lesson in that turn;
  replay lessons link the owner observation, live ones carry the host-recorded source message). Live
  proof pending: a Telegram answer without ids and a lesson row from a live correction after the daemon
  picks up the new standing text (new session on the prompt change).
- 2026-09-26 11:20 KST: R1/R2 live (daemon restarted on the new standing text; new Codex thread). Four
  owner turns on Telegram, all without ids: "<asset-2> SSR1" 23 s (was 56 s), its feedback 41 s — now
  in order: 9/11 side-hair feedback, 9/14 PDF (details not in the ledger), second draft, 9/17 FIX; the
  agent read work.show history:"all" this time. "전체보고" 42 s but in chat style; the owner corrected
  it and the agent saved a lesson in that turn (kind lesson, provenance source_message_ref = the
  correction's Telegram message) and resent a report-style version. Still failing: the Korean name
  missed in work.list text again (the agent fell back to "SSR1", 50 rows); the full-report format is
  not known (R5); the board slots are from 9/25 (no live board pass, R4); lesson recall after a reset is
  unbuilt (R3).
- R9 code check: readWork keeps its current default, exposes an internal chain mode, and work.show
  defaults to the compact revision chain while history: all keeps full assignment values.
- Evidence: seven-revision set/clear/withdraw fold, inaccessible judgment summary nulling, and the
  work.show catalog roundtrip pass; knowledge/api suites pass 24 files / 225 tests and core tsc passes.
- Still open: a fresh live owner C2 turn using the new default has not been run in this code-only change.
- 2026-09-26 12:00 KST: owner-reports R9 (Codex implemented; supervisor removed a copied visibility
  query and a wrapper). work.show now returns the revision chain by default — per revision: number,
  operation, event time (null for legacy rows), the status and stage in effect after it (withdraw →
  cancelled), and the revision's summary when its record is visible to the caller; history "all" keeps
  the full values; readWork's own default is unchanged for other callers. Core knowledge+api 225/225,
  typecheck clean. Live proof pending with R8 (one daemon restart for both).
