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
