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
