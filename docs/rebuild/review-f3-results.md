# F3 review fixes — 2026-09-27

Branch: `review/f3`. All 19 items were reverified and fixed; none skipped. No commits. No edits under `packages/standalone`.

Purpose: shared-engine isolation and the Answer/Learn checks in INTENT.md. These regressions prove implementation behavior; no live owner acceptance, daemon deployment or live data migration was performed.

## Per-item result

Counts below are final **whole-file** additions/deletions relative to HEAD; a shared file appears on every item it serves, so do not sum repeated counts. New files count every line as an addition.

| Item  | Status and current-code finding / fix                                                                                                                                              | Files changed (+/−)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Regression evidence                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| F3.1  | **fixed** — Modern API key shapes were absent from the shared scanner/redactor; both are now scanned and fully masked.                                                             | [packages/mama-core/src/memory/secret-filter.ts](../../packages/mama-core/src/memory/secret-filter.ts) (+8/−2)<br>[packages/mama-core/tests/memory/secret-filter.test.ts](../../packages/mama-core/tests/memory/secret-filter.test.ts) (+8/−0)                                                                                                                                                                                                                                                                                                                 | Both provider-pattern tests returned no matches before the fix.                                                            |
| F3.2  | **fixed** — Consumer migration numbers entered core-only handlers and repair; both paths now require the core source.                                                              | [packages/mama-core/src/db-adapter/node-sqlite-adapter.ts](../../packages/mama-core/src/db-adapter/node-sqlite-adapter.ts) (+8/−6)<br>[packages/mama-core/tests/migrations/review-f3.test.ts](../../packages/mama-core/tests/migrations/review-f3.test.ts) (+83/−0)                                                                                                                                                                                                                                                                                            | Consumer SQL at 72/73/74/77/79 did not run; a consumer file triggered core index repair.                                   |
| F3.3  | **fixed** — Instance recall expanded through the global DB; expansion now uses the supplied adapter.                                                                               | [packages/mama-core/src/memory/api.ts](../../packages/mama-core/src/memory/api.ts) (+5/−21)<br>[packages/mama-core/tests/unit/recall-graph-expansion.test.ts](../../packages/mama-core/tests/unit/recall-graph-expansion.test.ts) (+50/−102)                                                                                                                                                                                                                                                                                                                   | Two real databases with identical IDs returned foreign graph content before the fix.                                       |
| F3.4  | **fixed** — Observation LIKE search deleted literal metacharacters; it now escapes them with an explicit SQL escape character.                                                     | [packages/mama-core/src/knowledge/graph-query.ts](../../packages/mama-core/src/knowledge/graph-query.ts) (+74/−28)<br>[packages/mama-core/tests/knowledge/review-f3-graph.test.ts](../../packages/mama-core/tests/knowledge/review-f3-graph.test.ts) (+174/−0)                                                                                                                                                                                                                                                                                                 | All three literal percent/underscore/backslash searches returned the wrong observation.                                    |
| F3.5  | **fixed** — Timeline slicing preceded recorded-time filtering and lost overflow evidence; filtering now precedes slicing and has_more reaches page coverage.                       | [packages/mama-core/src/knowledge/graph-query.ts](../../packages/mama-core/src/knowledge/graph-query.ts) (+74/−28)<br>[packages/mama-core/tests/knowledge/review-f3-graph.test.ts](../../packages/mama-core/tests/knowledge/review-f3-graph.test.ts) (+174/−0)                                                                                                                                                                                                                                                                                                 | A later matching record disappeared behind limit=1; overflow was unreported.                                               |
| F3.6  | **fixed** — Run-finished observer exceptions escaped after commit; synchronous and async observer failures are logged without failing the committed turn.                          | [packages/mama-core/src/runtime/native-turn.ts](../../packages/mama-core/src/runtime/native-turn.ts) (+17/−9)<br>[packages/mama-core/tests/runtime/native-turn.test.ts](../../packages/mama-core/tests/runtime/native-turn.test.ts) (+34/−1)                                                                                                                                                                                                                                                                                                                   | The synchronous observer rejected the turn; the async observer produced an unhandled rejection.                            |
| F3.7  | **fixed** — Pending coalescing could select already dispatched native inputs; it now excludes native states other than prepared.                                                   | [packages/mama-core/src/runtime/mailbox.ts](../../packages/mama-core/src/runtime/mailbox.ts) (+1/−0)<br>[packages/mama-core/tests/runtime/mailbox-payload.test.ts](../../packages/mama-core/tests/runtime/mailbox-payload.test.ts) (+32/−0)                                                                                                                                                                                                                                                                                                                    | Dispatching, accepted and uncertain rows absorbed fresh work before the fix.                                               |
| F3.8  | **fixed** — Read scopes used ambiguous concatenation and rejected overlapping admitted scopes; tuple keys deduplicate admitted reads while explicit duplicate requests still fail. | [packages/mama-core/src/memory/api.ts](../../packages/mama-core/src/memory/api.ts) (+5/−21)<br>[packages/mama-core/tests/api/review-f3.test.ts](../../packages/mama-core/tests/api/review-f3.test.ts) (+153/−0)                                                                                                                                                                                                                                                                                                                                                | Overlapping access/readScopes threw; collision cases are covered in the same regression.                                   |
| F3.9  | **fixed** — Path count/depth did not bound unreachable dense searches; frontier is capped at 1000 paths and raw edge work at 10000 candidates, with limit_reached.                 | [packages/mama-core/src/knowledge/graph-query.ts](../../packages/mama-core/src/knowledge/graph-query.ts) (+74/−28)<br>[packages/mama-core/tests/knowledge/review-f3-graph.test.ts](../../packages/mama-core/tests/knowledge/review-f3-graph.test.ts) (+174/−0)                                                                                                                                                                                                                                                                                                 | Disconnected fanout and 11000 hidden edges returned no truncation reason; bounded scan is asserted.                        |
| F3.10 | **fixed** — memory.update ignored target scope bindings; scoped targets now require at least one admitted write scope, with read-only scopes excluded.                             | [packages/mama-core/src/api/catalog.ts](../../packages/mama-core/src/api/catalog.ts) (+26/−0)<br>[packages/mama-core/tests/api/review-f3.test.ts](../../packages/mama-core/tests/api/review-f3.test.ts) (+153/−0)                                                                                                                                                                                                                                                                                                                                              | Foreign-scoped update completed before the fix; the regression verifies unchanged outcome and permitted same-scope update. |
| F3.11 | **fixed** — Checkpoint writes lacked the recallableWrite contract flag; the existing shared secret gate now runs before checkpoint persistence.                                    | [packages/mama-core/src/api/catalog.ts](../../packages/mama-core/src/api/catalog.ts) (+26/−0)<br>[packages/mama-core/tests/api/review-f3.test.ts](../../packages/mama-core/tests/api/review-f3.test.ts) (+153/−0)                                                                                                                                                                                                                                                                                                                                              | A credential in open_files was persisted before the fix.                                                                   |
| F3.12 | **fixed** — Current-history hydration followed merged identities without rechecking visibility; the resolved identity is now checked before hydration.                             | [packages/mama-core/src/knowledge/graph-query.ts](../../packages/mama-core/src/knowledge/graph-query.ts) (+74/−28)<br>[packages/mama-core/tests/knowledge/review-f3-graph.test.ts](../../packages/mama-core/tests/knowledge/review-f3-graph.test.ts) (+174/−0)                                                                                                                                                                                                                                                                                                 | After a scope change on a merged survivor, the old visible seed exposed the restricted survivor.                           |
| F3.13 | **fixed** — ASCII word boundaries excluded Korean particles; Korean alternatives now match attached particles while preserving the English boundaries.                             | [packages/mama-core/src/knowledge/question-type.ts](../../packages/mama-core/src/knowledge/question-type.ts) (+6/−6)<br>[packages/mama-core/tests/knowledge/question-type.test.ts](../../packages/mama-core/tests/knowledge/question-type.test.ts) (+13/−0)                                                                                                                                                                                                                                                                                                    | Six Korean query categories returned unknown; an additional regression prevents 전체 from matching 전.                     |
| F3.14 | **fixed** — External source.ingest accepted reserved owner-message:/owner-result: source prefixes; it now rejects them before ingestion.                                           | [packages/mama-core/src/api/catalog.ts](../../packages/mama-core/src/api/catalog.ts) (+26/−0)<br>[packages/mama-core/tests/api/review-f3.test.ts](../../packages/mama-core/tests/api/review-f3.test.ts) (+153/−0)                                                                                                                                                                                                                                                                                                                                              | Both reserved connector inputs were persisted before the fix.                                                              |
| F3.15 | **fixed** — IPC encoding could throw inside connect and leave the Promise unsettled; encoding now rejects before connect and settle clears the deadline.                           | [packages/mama-core/src/client/ipc.ts](../../packages/mama-core/src/client/ipc.ts) (+14/−3)<br>[packages/mama-core/tests/runtime/ipc-settlement.test.ts](../../packages/mama-core/tests/runtime/ipc-settlement.test.ts) (+111/−0)                                                                                                                                                                                                                                                                                                                              | Circular/oversized inputs timed out with uncaught errors; settled responses retained a timer.                              |
| F3.16 | **fixed** — Applied 095 had an unguarded JSON join expression; new migration 097 guards it independently without editing any applied migration.                                    | [packages/mama-core/db/migrations/097-native-input-json-validity.sql](../../packages/mama-core/db/migrations/097-native-input-json-validity.sql) (+37/−0)<br>[packages/mama-core/tests/migrations/review-f3.test.ts](../../packages/mama-core/tests/migrations/review-f3.test.ts) (+83/−0)                                                                                                                                                                                                                                                                     | A principal-filtered view read over malformed historical JSON raised malformed JSON before 097.                            |
| F3.17 | **fixed** — Unknown scope kinds had NaN sort ranks, grants used aliases verbatim, and journal hashing rejected optional undefined fields; all three contracts are normalized.      | [packages/mama-core/src/memory/types.ts](../../packages/mama-core/src/memory/types.ts) (+8/−8)<br>[packages/mama-core/src/api/dispatch.ts](../../packages/mama-core/src/api/dispatch.ts) (+1/−1)<br>[packages/mama-core/src/client/client.ts](../../packages/mama-core/src/client/client.ts) (+7/−1)<br>[packages/mama-core/tests/api/review-f3.test.ts](../../packages/mama-core/tests/api/review-f3.test.ts) (+153/−0)<br>[packages/mama-core/tests/runtime/ipc-settlement.test.ts](../../packages/mama-core/tests/runtime/ipc-settlement.test.ts) (+111/−0) | Reversed custom scopes hashed differently, canonical grants denied aliases, and undefined input failed before send.        |
| F3.18 | **fixed** — The stdio smoke test used ignored snake_case options and asserted only success. It now uses the schema names and requires the saved decision in the result.            | [packages/mcp-server/tests/integration/stdio.test.js](../../packages/mcp-server/tests/integration/stdio.test.js) (+14/−5)                                                                                                                                                                                                                                                                                                                                                                                                                                      | The schema assertion failed on decision_limit before the option correction.                                                |
| F3.19 | **fixed** — Configure omitted MAMA_DATABASE_PATH; it now documents MAMA_DB_PATH > MAMA_DATABASE_PATH > the default.                                                                | [packages/claude-code-plugin/commands/configure.md](../../packages/claude-code-plugin/commands/configure.md) (+3/−1)<br>[packages/claude-code-plugin/tests/core/configure-database.test.js](../../packages/claude-code-plugin/tests/core/configure-database.test.js) (+48/−0)                                                                                                                                                                                                                                                                                  | The precedence assertion failed with the old document; all three resolver cases run under temporary HOME.                  |

## Test commands and results

Every listed package command was executed with that package as the working directory. DB fixtures use a temporary file before initDB(), or an explicitly named temporary adapter. HOME/config tests use a temporary HOME.

From `packages/mama-core` (the final combined regression run, covering F3.1–17):

```sh
pnpm exec vitest run tests/knowledge/question-type.test.ts tests/knowledge/review-f3-graph.test.ts tests/runtime/ipc-settlement.test.ts tests/api/review-f3.test.ts tests/migrations/review-f3.test.ts tests/unit/recall-graph-expansion.test.ts tests/memory/secret-filter.test.ts tests/runtime/native-turn.test.ts tests/runtime/mailbox-payload.test.ts
pnpm exec vitest run tests/knowledge/review-f3-graph.test.ts tests/knowledge/graph-roundtrip.test.ts tests/knowledge/agent-graph.test.ts
pnpm typecheck
pnpm build
```

- Final combined regression run: **9 files, 93 tests passed**. Graph integration run: **3 files, 34 tests passed**. Typecheck and final build passed.

From `packages/mcp-server` (F3.18):

```sh
pnpm exec vitest run tests/integration/stdio.test.js
pnpm --manage-package-manager-versions=false test
```

- Package suite: **15 files, 139 tests passed**. Final stdio rerun: **1 file, 2 tests passed**.

From `packages/claude-code-plugin` (F3.19):

```sh
pnpm exec vitest run tests/core/configure-database.test.js
pnpm --manage-package-manager-versions=false test
```

- Precedence regression: **4 tests passed**. Package suite: **12 files, 170 tests passed**.

All three full suites were launched from their package directories with an isolated HOME, temporary MAMA_DB_PATH, and a link to the existing model cache. `pnpm test` initially attempted to install pnpm in the new HOME and failed on restricted DNS; disabling automatic package-manager downloads allowed the installed pnpm to run the suites.

From `packages/mama-core`, full suite:

```sh
pnpm --manage-package-manager-versions=false test
```

Final full run: **123 files passed, 7 files failed; 870 tests passed, 44 tests failed (935 collected)**. The failed suites stop at sandbox-denied Unix `listen` (`EPERM`); the IPC suite additionally raises a cleanup error because its server never started. 21 collected tests are not reported as run after suite setup failures. No remaining assertion failure appeared outside those socket-dependent suites.

| Blocked file                                        | Reported failures  | Cause                                                               |
| --------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `tests/runtime/experience-read-over-socket.test.ts` | 1 failure entries  | Unix socket listen EPERM                                            |
| `tests/runtime/intake-is-the-runtimes.test.ts`      | 18 failure entries | Unix socket listen EPERM                                            |
| `tests/runtime/ipc-actions.test.ts`                 | 2 failure entries  | Unix socket listen EPERM; additional undefined server cleanup error |
| `tests/runtime/native-input-delivery.test.ts`       | 19 failure entries | Unix socket listen EPERM                                            |
| `tests/runtime/principal-grants.test.ts`            | 1 failure entries  | Unix socket listen EPERM                                            |
| `tests/runtime/replay-session-facts.test.ts`        | 1 failure entries  | Unix socket listen EPERM                                            |
| `tests/runtime/runtime-lifecycle.test.ts`           | 6 failure entries  | Unix socket listen EPERM                                            |

Failure entry counts include suite setup/teardown errors and therefore differ from the 44 failed test cases.

<details>
<summary>Reported failing suite/test names</summary>

- `tests/runtime/experience-read-over-socket.test.ts`
  - an advertised core action over the real client route
- `tests/runtime/intake-is-the-runtimes.test.ts`
  - startRuntime opens the intake it owns > keeps a second served principal out of the owner input view
  - startRuntime opens the intake it owns > the mailbox the runtime opened is the one the drain reads
  - startRuntime opens the intake it owns > the intake outlives nothing it did not open: stop closes the socket, not the store
  - stop closes what start opened, in an order that makes each close safe > releases the harness before the socket the harness is still calling
  - stop closes what start opened, in an order that makes each close safe > a runtime that opened no harness does not pretend to close one
  - accept is the one door, and it refuses loudly > refuses a principal this runtime does not serve
  - accept is the one door, and it refuses loudly > refuses a kind no producer may state
  - accept is the one door, and it refuses loudly > refuses a stimulus with no channel identity
  - accept is the one door, and it refuses loudly > refuses when the runtime opened no intake, rather than dropping it quietly
  - the receipt says acceptance and nothing more > carries no outcome, classification or work status
  - the receipt says acceptance and nothing more > a redelivered stimulus is a duplicate, and nothing is lost
  - the receipt says acceptance and nothing more > all three v7 kinds enter the same door
  - the runtime carries what it accepted through to the loop > delivers on accept, acks what the loop took, and leaves nothing pending
  - the runtime carries what it accepted through to the loop > a delivery that throws is owed again, not lost and not acked
  - the runtime carries what it accepted through to the loop > the owner’s own message does not wait behind a mass replay
  - the runtime carries what it accepted through to the loop > repeated drains re-attempt nothing and report no phantom work
  - the runtime carries what it accepted through to the loop > a runtime with no delivery keeps what it accepted for whoever drains it
  - the runtime carries what it accepted through to the loop > stop ends the drain: nothing is delivered after it
- `tests/runtime/ipc-actions.test.ts`
  - Story R2: client/ipc — describe, call, getOperation over a real Unix socket
  - Story R2: client/ipc — describe, call, getOperation over a real Unix socket
- `tests/runtime/native-input-delivery.test.ts`
  - v7 R2: native acceptance is durable and separate from adapter completion > keeps a child completion accepted during native stop for the next runtime
  - v7 R2: native acceptance is durable and separate from adapter completion > waits for an active durable-result reconciliation before closing the runtime
  - v7 R2: native acceptance is durable and separate from adapter completion > admits the next input after native ACK while the first result is still running
  - v7 R2: native acceptance is durable and separate from adapter completion > journals a second input steered into the same native turn under its own mailbox row
  - v7 R2: native acceptance is durable and separate from adapter completion > refuses an unaccepted steering target before native dispatch
  - v7 R2: native acceptance is durable and separate from adapter completion > can start one fresh turn after a stale steer is rejected before dispatch
  - v7 R2: native acceptance is durable and separate from adapter completion > does not steer an owner input into another principal's accepted turn
  - v7 R2: native acceptance is durable and separate from adapter completion > does not replay a steer whose native acknowledgement was lost after dispatch
  - v7 R2: native acceptance is durable and separate from adapter completion > does not reclaim a live pre-dispatch admission when its lease expires
  - v7 R2: native acceptance is durable and separate from adapter completion > keeps the result writer alive through shutdown and leaves later intake durable
  - v7 R2: native acceptance is durable and separate from adapter completion > executes only a currently claimed input through the runtime-owned native session
  - v7 R2: native acceptance is durable and separate from adapter completion > owns an invoked native run even if the adapter returns before awaiting it
  - v7 R2: native acceptance is durable and separate from adapter completion > keeps a native receipt claimed before the result or reply is ready
  - v7 R2: native acceptance is durable and separate from adapter completion > reopens an accepted input and reconciles its result without another model dispatch
  - v7 R2: native acceptance is durable and separate from adapter completion > does not replay a dispatch whose native acknowledgement was lost
  - v7 R2: native acceptance is durable and separate from adapter completion > keeps an unresolved accepted input beyond ordinary ACK retention
  - v7 R2: native acceptance is durable and separate from adapter completion > retains the first receipt and rejects a different session or second dispatch
  - v7 R2: native acceptance is durable and separate from adapter completion > migrates old claims as unknown, without fabricating a native identity or replaying them
  - v7 R2: native acceptance is durable and separate from adapter completion > retries a definite failure before native dispatch using the same durable identity
- `tests/runtime/principal-grants.test.ts`
  - W1: the credential names the principal, and the grant gates dispatch
- `tests/runtime/replay-session-facts.test.ts`
  - replay session facts over the action socket > reads the active ceiling dynamically for separate MCP-style calls
- `tests/runtime/runtime-lifecycle.test.ts`
  - Story R3: runtime.start/stop — the single owner of the action socket > start writes a 0600 credential and serves describe plus a real call
  - Story R3: runtime.start/stop — the single owner of the action socket > a credential the runtime did not issue is denied before any action runs
  - Story R3: runtime.start/stop — the single owner of the action socket > serves a newly registered principal without restarting and revokes its socket identity
  - Story R3: runtime.start/stop — the single owner of the action socket > a second start on a live socket is refused — one start subject per profile
  - Story R3: runtime.start/stop — the single owner of the action socket > a dead socket file is reclaimed, not served alongside
  - Story R3: runtime.start/stop — the single owner of the action socket > stop closes only what start opened: socket dead, credential gone

</details>

IPC regression testing substitutes only socket I/O after the sandbox refused a real Unix listener. Encoding, request correlation, response decoding, Promise settlement, deadline cleanup, JSON normalization and the on-disk operation journal are the production implementations. This does not establish a successful real-socket integration run.

Changed JavaScript/TypeScript files pass ESLint and Prettier. `git diff --check` passes.

## Contract and migration decisions

- Only migration **097-native-input-json-validity.sql** is added; applied migrations, including 095, remain unchanged. Consumer sources never enter the specified core repair handlers.

- `GraphTimelineResult.has_more` distinguishes complete pages from omitted events; recorded time filtering precedes limiting. `GraphPathsResult.limit_reached` marks path-count/frontier/raw-edge work caps; queryGraph forwards that into coverage reasons.

- Outcome updates use write scopes, aliases use canonical grants, checkpoints use the shared recallable-write scanner, and external ingestion cannot impersonate reserved source namespaces. Legacy unscoped outcome behavior remains as specified by the existing judgment boundary.

- An `onRunFinished` callback is an observer, including when asynchronous: failures are logged and cannot reverse a committed turn.

- AGENTS.md requested recording these decisions via MAMA MCP save. The attempted `f3_shared_engine_review_contracts` save was **not persisted**: the tool returned `MCP tool call requires approval, but approval policy is never`. The decisions are recorded here and in checks.md.

## Scope and totals

27 files changed: **+1226 / −194 lines**, including tests and review evidence. Shared file counts in the per-item table are counted once here.

- Bundled plugin inspection found no duplicated implementation files for these fixes (src/core contains only hook-features.js and instructions); it consumes the shared package. Its full suite passed against the built core.

- No standalone edits, live configuration writes, database edits outside temporary test fixtures, commits or branch changes were made.
