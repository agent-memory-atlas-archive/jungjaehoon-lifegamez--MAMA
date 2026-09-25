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
