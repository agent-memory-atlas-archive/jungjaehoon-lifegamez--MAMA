# F1 / F2 review fixes — 2026-09-27

28 items fixed; 2 skipped with reasons below. Working tree remains uncommitted on `rebuild/owner-flow`. Only `packages/standalone` was changed. No real `~/.mama` access, service mutation, core/MCP/plugin edit, or SQL schema change. `docs/rebuild/checks.md` was not edited because this task explicitly limits edits to standalone; this file holds the per-item evidence.

Owner checks: Recognise/Attach collection integrity, Answer recovery and safe evidence access, Report delivery and prompts, Learn scope propagation. These regressions are code-level evidence; they do not establish live owner acceptance.

All test commands ran inside `packages/standalone`, with a temporary HOME and a temporary `MAMA_DB_PATH` where the core database could initialize. For each item, command A below includes the listed test file(s). Per-file +/− counts are the complete final diff for that file; shared files recur across items and must not be summed twice.

## F1.1 — fixed

- Reverified: Claimed/uncertain inputs stayed pending and reconciliation ignored owner/source/native results. Reuse the durable result without rerunning the model; park and log result-less orphans, then deliver the interrupted notice.
- Files: `src/runtime/stimulus-delivery.ts` (+64/−28), `src/runtime/owner-runtime.ts` (+14/−6), `src/cli/commands/daemon.ts` (+34/−39), `src/gateways/telegram.ts` (+107/−40), `tests/runtime/owner-recovery.test.ts` (+203/−0), `tests/cli/daemon-delta-report.test.ts` (+33/−10).
- Tests run: command A, `tests/runtime/owner-recovery.test.ts`, `tests/cli/daemon-delta-report.test.ts`.
- Evidence / remaining limit: RED: six restart recovery assertions and the live interrupted-notice assertion failed. GREEN: stored answers, uncertain read-back, no extra model run, and Telegram interruption output verified.

## F1.2 — fixed

- Reverified: Workspace .claude settings retained arbitrary hooks and were writable by native tools. Rewrite both files whole, deny native/sandbox writes to that host-owned directory, and remove the early incomplete writer.
- Files: `src/agent/claude-native-tool-policy.ts` (+11/−2), `src/cli/runtime/claude-caller-config.ts` (+23/−38), `src/runtime/native-session.ts` (+11/−3), `src/cli/commands/daemon.ts` (+34/−39), `tests/cli/claude-caller-config.test.ts` (+23/−8), `tests/cli/daemon-boot.test.ts` (+36/−9).
- Tests run: command A, `tests/cli/claude-caller-config.test.ts`, `tests/cli/daemon-boot.test.ts`.
- Evidence / remaining limit: RED: injected settings survived, deny lists missed .claude, and daemon wrote settings early. GREEN: configuration and assembly regressions pass. Real backend execution not exercised.

## F1.3 — fixed

- Reverified: A mutable next-turn ceiling could be consumed by an owner message. Derive the active inclusive ceiling from the source row replay.windowEndMs, remove setter/feeder ambient state, clear it after delivery.
- Files: `src/runtime/stimulus-delivery.ts` (+64/−28), `src/runtime/owner-runtime.ts` (+14/−6), `src/replay/replay-feeder.ts` (+0/−6), `src/cli/commands/replay.ts` (+0/−1), `tests/runtime/owner-recovery.test.ts` (+203/−0), `tests/runtime/stimulus-delivery.test.ts` (+2/−2), `tests/replay/replay-feeder.test.ts` (+1/−1), `tests/cli/daemon-delta-report.test.ts` (+33/−10).
- Tests run: command A, `tests/runtime/owner-recovery.test.ts`, `tests/runtime/stimulus-delivery.test.ts`, `tests/replay/replay-feeder.test.ts`, `tests/cli/daemon-delta-report.test.ts`.
- Evidence / remaining limit: RED: owner-first replay sequence saw no ceilings. GREEN: independent payload ceilings 1500 and 2000, active tool ceiling, cleanup and feeder payload verified.

## F1.4 — fixed

- Reverified: Configured replay key was absent from credential read denies. Carry resolved jev.keyFile from daemon through owner runtime to both native backends and Claude sandbox.
- Files: `src/runtime/backend-security.ts` (+6/−1), `src/runtime/native-session.ts` (+11/−3), `src/runtime/owner-runtime.ts` (+14/−6), `src/cli/commands/daemon.ts` (+34/−39), `tests/runtime/native-session.test.ts` (+10/−1), `tests/cli/daemon-boot.test.ts` (+36/−9).
- Tests run: command A, `tests/runtime/native-session.test.ts`, `tests/cli/daemon-boot.test.ts`.
- Evidence / remaining limit: RED: configured key missing in both backend deny inputs and daemon option. GREEN: assembly and policy assertions pass.

## F1.5 — fixed

- Reverified: memory.read:provenance bypassed the shared external-evidence wrapper. Quote it for both model-facing transports.
- Files: `src/utils/untrusted-content.ts` (+1/−0), `tests/runtime/owner-security.test.ts` (+2/−1), `tests/runtime/native-session.test.ts` (+10/−1).
- Tests run: command A, `tests/runtime/owner-security.test.ts`, `tests/runtime/native-session.test.ts`.
- Evidence / remaining limit: RED: raw provenance lacked untrusted marker. GREEN: quoted data and stripped injected closing marker; stored input/receipt unchanged.

## F1.6 — fixed

- Reverified: Recovery discarded outbound keys. Recover ready entries from stored response/chunk receipts, preserving destination and idempotency. Definitive API rejection is retryable; ambiguous sends remain visibly uncertain. Missing recovery metadata fails loudly.
- Files: `src/gateways/telegram.ts` (+107/−40), `src/gateways/telegram-errors.ts` (+5/−0), `tests/gateways/telegram.test.ts` (+225/−4), `tests/cli/daemon-scheduled-report.test.ts` (+11/−12), `tests/cli/daemon-delta-report.test.ts` (+33/−10).
- Tests run: command A, `tests/gateways/telegram.test.ts`, `tests/cli/daemon-scheduled-report.test.ts`, `tests/cli/daemon-delta-report.test.ts`.
- Evidence / remaining limit: RED: safe ready send lost, concurrent recovery duplicated, uncertain send retried, missing format/progress silently defaulted. GREEN: restart recovery and stored report recovery without another model attempt; ambiguous outcomes not resent.

## F1.7 — fixed

- Reverified: class+path dedupe permitted scanner alert floods and anonymous 404s were auth_failed. Dedupe per class/window, persist every event with suppressed counts, classify 404 as request_failed.
- Files: `src/api/security-events.ts` (+16/−12), `src/api/viewer-request-security.ts` (+2/−1), `tests/api/viewer-security.test.ts` (+61/−38).
- Tests run: command A, `tests/api/viewer-security.test.ts`.
- Evidence / remaining limit: RED: excess alerts and anonymous 404 misclassification. GREEN: per-class suppression/counts, next-window summary, failed/pending alert delivery covered.

## F1.8 — fixed

- Reverified: status/stop consumed an unwritten PID file. Use launchctl print/bootout on gui/<uid>/com.mama.server; remove PID helpers.
- Files: `src/cli/commands/daemon.ts` (+34/−39), `tests/cli/daemon-service.test.ts` (+58/−0).
- Tests run: command A, `tests/cli/daemon-service.test.ts`.
- Evidence / remaining limit: RED: running service reported stopped, bootout absent, errors swallowed. GREEN: loaded/running/absent state, stop and fail-loud command errors. Real service not queried or stopped.

## F1.9 — fixed

- Reverified: Fatal Telegram polling rejection only logged and left the process deaf. Gateway reports fatal error; daemon logs and exits 1 for launchd restart.
- Files: `src/gateways/telegram.ts` (+107/−40), `src/cli/commands/daemon.ts` (+34/−39), `tests/gateways/telegram.test.ts` (+225/−4), `tests/cli/daemon-boot.test.ts` (+36/−9).
- Tests run: command A, `tests/gateways/telegram.test.ts`, `tests/cli/daemon-boot.test.ts`.
- Evidence / remaining limit: RED: fatal callback and daemon process.exit were never called. GREEN: original error reaches callback, diagnostic log and exit 1 verified with process/transport seams.

## F1.10 — fixed

- Reverified: Source and Telegram attachment writes followed symlinked destinations. Resolve containment after mkdir, return canonical directory, write exclusively opened temporary file then rename.
- Files: `src/api/attachment-actions.ts` (+26/−24), `src/connectors/framework/attachment-io.ts` (+18/−2), `src/gateways/telegram-attachments.ts` (+18/−4), `tests/api/attachment-actions.test.ts` (+96/−4), `tests/connectors/attachment-io.test.ts` (+28/−3), `tests/gateways/telegram-attachments.test.ts` (+44/−2).
- Tests run: command A, `tests/api/attachment-actions.test.ts`, `tests/connectors/attachment-io.test.ts`, `tests/gateways/telegram-attachments.test.ts`.
- Evidence / remaining limit: RED: directory escapes and pre-existing temp/target symlinks wrote outside. GREEN: outside contents preserved, safe downloads succeed, owned temp cleanup verified.

## F1.11 — fixed

- Reverified: finalize failure retained a stale presenter with obsolete chunk position. Drop presenter in finally, propagate failure, reconstruct from durable progress for safe retry.
- Files: `src/gateways/telegram.ts` (+107/−40), `src/gateways/telegram-response-presenter.ts` (+5/−0), `src/gateways/telegram-errors.ts` (+5/−0), `tests/gateways/telegram.test.ts` (+225/−4).
- Tests run: command A, `tests/gateways/telegram.test.ts`.
- Evidence / remaining limit: RED: confirmed first chunk resent and ambiguous response retry accepted. GREEN: safe retry resumes correct chunk; uncertain outcome stays parked.

## F1.12 — fixed

- Reverified: A later invalid connector interval left an earlier timer running. Validate all enabled intervals before startup/polling/timer creation.
- Files: `src/runtime/connectors.ts` (+11/−4), `tests/runtime/connectors.test.ts` (+32/−0).
- Tests run: command A, `tests/runtime/connectors.test.ts`.
- Evidence / remaining limit: RED: rejected startup had already created a timer. GREEN: invalid interval creates no timer.

## F1.13 — fixed

- Reverified: Lesson recall used only options.scopes, omitting the computed owner user/connector scopes. Use surface.ownerAccess.scopes.
- Files: `src/runtime/owner-runtime.ts` (+14/−6), `tests/runtime/owner-runtime-lessons.test.ts` (+7/−1).
- Tests run: command A, `tests/runtime/owner-runtime-lessons.test.ts`.
- Evidence / remaining limit: RED: recall dependency received only global scope. GREEN: global/user/channel/project access scopes reach recall.

## F1.14 — fixed

- Reverified: Oversized photos were sent as photos and failed file operations stayed processing. Route >10 MiB images as documents; persist failed+uncertain file claims and rethrow.
- Files: `src/api/file-delivery.ts` (+47/−9), `src/gateways/telegram.ts` (+107/−40), `src/gateways/telegram-message-ledger.ts` (+19/−2), `tests/gateways/telegram.test.ts` (+225/−4).
- Tests run: command A, `tests/gateways/telegram.test.ts`.
- Evidence / remaining limit: RED: oversized photo route and processing claim after failure. GREEN: document route and failed claim survive reload; same failed operation is not resent.

## F1.15 — fixed

- Reverified: Telegram animation containing document metadata downloaded twice. Skip document when animation is present.
- Files: `src/gateways/telegram-attachments.ts` (+18/−4), `tests/gateways/telegram-attachments.test.ts` (+44/−2).
- Tests run: command A, `tests/gateways/telegram-attachments.test.ts`.
- Evidence / remaining limit: RED: two descriptors/downloads. GREEN: one file, one download, expected bytes.

## F1.16 — fixed

- Reverified: Cached JWKS never refreshed for unknown kid. Refetch once per issuer/minute and share concurrent refresh attempts.
- Files: `src/api/cf-access.ts` (+24/−9), `tests/api/cf-access.test.ts` (+31/−0).
- Tests run: command A, `tests/api/cf-access.test.ts`.
- Evidence / remaining limit: RED: valid rotated key denied and refresh not attempted. GREEN: rotation, unknown-key flood, failed refresh, and valid existing cached key covered.

## F1.17 — fixed

- Reverified: Viewer echoed arbitrary localhost origins despite local authentication. Remove localhost CORS echo.
- Files: `src/api/viewer-server.ts` (+0/−6), `tests/api/viewer-security.test.ts` (+61/−38).
- Tests run: command A, `tests/api/viewer-security.test.ts`.
- Evidence / remaining limit: RED: untrusted localhost origin was returned. GREEN: localhost and 127.0.0.1 origins receive no CORS grant.

## F1.18 — fixed

- Reverified: InputFile reopened a path after validation. Open with O_NOFOLLOW, fstat, stream that descriptor, and close after upload.
- Files: `src/api/file-delivery.ts` (+47/−9), `src/gateways/telegram.ts` (+107/−40), `tests/gateways/telegram.test.ts` (+225/−4).
- Tests run: command A, `tests/gateways/telegram.test.ts`.
- Evidence / remaining limit: RED: path replacement uploaded outside bytes. GREEN: real InputFile consumes the originally opened file after pathname replacement.

## F1.19 — fixed

- Reverified: Unexpected CLI errors discarded name/code. Print bounded diagnostic identifiers while retaining expected user-input error text.
- Files: `src/cli/index.ts` (+16/−5), `tests/cli/cli-errors.test.ts` (+26/−0).
- Tests run: command A, `tests/cli/cli-errors.test.ts`.
- Evidence / remaining limit: RED: generic text omitted TypeError/EACCES. GREEN: name/code and exit 1 without private detail.

## F1.20 — fixed

- Reverified: Report sends used random attempt IDs. Use report:<hourKey>:<full|reminder> for delivery identity.
- Files: `src/runtime/report-scheduler.ts` (+1/−1), `tests/runtime/report-scheduler.test.ts` (+28/−1), `tests/cli/daemon-scheduled-report.test.ts` (+11/−12).
- Tests run: command A, `tests/runtime/report-scheduler.test.ts`, `tests/cli/daemon-scheduled-report.test.ts`.
- Evidence / remaining limit: RED: schedule state-write failure followed by a new model attempt produced different keys. GREEN: stable hour/type keys, actual outbound ledger and suppression verified.

## F1.21 — skipped — outside allowed package

- Reverified: Real defect is in packages/mama-core/src/runtime/drivers/persistent-cli-process.ts:1500-1505; standalone contains no SIGKILL/.killed path. Core is explicitly assigned to the other worker and was not edited.
- Files: none (+0/−0).
- Tests run: none; outside scope.
- Evidence / remaining limit: No change/test for this item; core worker must handle exit tracking.

## F1.22 — fixed

- Reverified: Generated standing prompts promised unsupported delivery after the turn and recommended run_in_background. Remove those claims while retaining delegation and result integration.
- Files: `src/runtime/owner-system-prompt.ts` (+2/−6), `tests/runtime/owner-prompt-boundaries.test.ts` (+14/−0).
- Tests run: command A, `tests/runtime/owner-prompt-boundaries.test.ts`.
- Evidence / remaining limit: RED: Claude/Codex generated prompts contained unsupported claims. GREEN: both generated prompt contracts corrected; no live model evaluation.

## F1.23 — fixed

- Reverified: Report prompt hard-coded owner lodging business content. Remove the whole source sentence as requested; external owner policy remains the destination.
- Files: `src/runtime/report-prompts.ts` (+0/−1), `tests/runtime/stimulus-delivery.test.ts` (+2/−2).
- Tests run: command A, `tests/runtime/stimulus-delivery.test.ts`.
- Evidence / remaining limit: RED: assembled scheduled full report included lodging/check-in/check-out text. GREEN: generated report input excludes it. Real owner policy was not read or changed, and no live owner turn was run as requested.

## F1.24 — fixed

- Reverified: Connector/handoff failures were swallowed and state-save errors escaped timer callbacks. Catch/log at pollOne, pollConnector and pollAll; retain cursor and release in-flight bookkeeping.
- Files: `src/connectors/framework/polling-scheduler.ts` (+14/−6), `tests/connectors/framework/polling-scheduler.test.ts` (+49/−1).
- Tests run: command A, `tests/connectors/framework/polling-scheduler.test.ts`.
- Evidence / remaining limit: RED: missing poll error log and two uncaught state-write rejections. GREEN: all error boundaries log and cursor remains unchanged after failed poll.

## F1.25 — fixed

- Reverified: Download manufactured a request using the requested file ID and validated only its room. Derive list/download requests from the preserved observation IDs or uploader/message/time match.
- Files: `src/api/attachment-actions.ts` (+26/−24), `tests/api/attachment-actions.test.ts` (+96/−4).
- Tests run: command A, `tests/api/attachment-actions.test.ts`.
- Evidence / remaining limit: RED: another message file in the same room downloaded. GREEN: both metadata-ID and matched-observation cases reject it.

## F2.1 — fixed

- Reverified: Failed historical import pages remained eligible for live admission. Persist collectOnly in existing pending JSON snapshots, set it at both imports, and exclude it from live admission; explicit historical drain still works.
- Files: `src/storage/source-archive.ts` (+16/−4), `src/replay/trello-import.ts` (+1/−1), `src/replay/kagemusha-import.ts` (+3/−2), `src/connectors/framework/polling-scheduler.ts` (+14/−6), `tests/replay/collect-only-admission.test.ts` (+106/−0).
- Tests run: command A, `tests/replay/collect-only-admission.test.ts`.
- Evidence / remaining limit: RED: both failed imports emitted historical deltas after RawStore reopen. GREEN: no live delta and explicit drain can recover them. No SQL schema change/migration.

## F2.2 — fixed

- Reverified: Chatwork advanced earlier-room cursors before later-room or handoff failure. Stage a map and commit/abort using existing poll handoff protocol.
- Files: `src/connectors/chatwork/index.ts` (+31/−2), `tests/connectors/chatwork.test.ts` (+60/−0).
- Tests run: command A, `tests/connectors/chatwork.test.ts`.
- Evidence / remaining limit: RED: messages lost after room failure or aborted handoff. GREEN: retry returns earlier-room messages and successful handoff commits.

## F2.3 — fixed

- Reverified: Replay JSON-parsed every Trello row although live snapshots are text. Select action rendering by stored actionType metadata; retain snapshot text without a parse-error fallback.
- Files: `src/replay/replay-source-catalog.ts` (+4/−1), `tests/replay/replay-source-catalog.test.ts` (+12/−1).
- Tests run: command A, `tests/replay/replay-source-catalog.test.ts`.
- Evidence / remaining limit: RED: mixed snapshot/action catalog threw SyntaxError. GREEN: both stored representations render.

## F2.4 — fixed

- Reverified: Scheduler and connector accepted different channel key forms. Both now use the same resolver with explicit existing key precedence.
- Files: `src/connectors/framework/polling-scheduler.ts` (+14/−6), `src/connectors/kagemusha/index.ts` (+7/−2), `tests/connectors/kagemusha.test.ts` (+27/−0).
- Tests run: command A, `tests/connectors/kagemusha.test.ts`.
- Evidence / remaining limit: RED: raw-key and origin-prefixed-key cases disagreed. GREEN: canonical/raw/origin forms and ignored channels agree.

## F2.5 — skipped — currently correct

- Reverified: Current reference schema declares channel_messages.created_at and tasks.updated_at as INTEGER milliseconds (003-channel-messages.sql default unixepoch()\*1000; 002-tasks.sql). Connector uses since.getTime() and numeric keyset comparisons already.
- Files: none (+0/−0).
- Tests run: command A, `tests/connectors/kagemusha.test.ts`.
- Evidence / remaining limit: Existing millisecond and >1000-row keyset tests pass. No speculative text-date compatibility path added.

## Verification commands and final results

Command A: all changed regression suites, excluding exactly three pre-existing socket-listen cases after they were run and reported by the full suite. The expression does not exclude any new regression.

```sh
cd packages/standalone
test_home=$(mktemp -d /private/tmp/mama-review-tests.XXXXXX)
env HOME="$test_home" MAMA_DB_PATH="$test_home/dev.db" ./node_modules/.bin/vitest run tests/api/attachment-actions.test.ts tests/api/cf-access.test.ts tests/api/viewer-security.test.ts tests/cli/claude-caller-config.test.ts tests/cli/cli-errors.test.ts tests/cli/daemon-boot.test.ts tests/cli/daemon-delta-report.test.ts tests/cli/daemon-scheduled-report.test.ts tests/cli/daemon-service.test.ts tests/connectors/attachment-io.test.ts tests/connectors/chatwork.test.ts tests/connectors/framework/polling-scheduler.test.ts tests/connectors/kagemusha.test.ts tests/gateways/telegram-attachments.test.ts tests/gateways/telegram.test.ts tests/replay/collect-only-admission.test.ts tests/replay/replay-feeder.test.ts tests/replay/replay-source-catalog.test.ts tests/runtime/connectors.test.ts tests/runtime/native-session.test.ts tests/runtime/owner-prompt-boundaries.test.ts tests/runtime/owner-recovery.test.ts tests/runtime/owner-runtime-lessons.test.ts tests/runtime/owner-security.test.ts tests/runtime/report-scheduler.test.ts tests/runtime/stimulus-delivery.test.ts -t '^(?!.*(?:authenticates MCP list|serializes a source delta and owner message|does not ack a native turn))'
```

Command B: full package test script (the local Vitest command is exactly `package.json` test; `pnpm test` with temporary HOME stalled before output and was interrupted).

```sh
cd packages/standalone
test_home=$(mktemp -d /private/tmp/mama-review-tests.XXXXXX)
env HOME="$test_home" MAMA_DB_PATH="$test_home/dev.db" ./node_modules/.bin/vitest run --passWithNoTests
./node_modules/.bin/tsc --noEmit
git diff --check
```

- Command A: **26 files passed; 304 tests passed; 3 explicitly excluded socket tests**. Log: `/private/tmp/mama-review-focused-final.log`.
- Command B: **86 files passed / 8 failed; 763 tests passed / 23 failed**. Every failure is `listen EPERM` at a Unix socket or `127.0.0.1` bind in the restricted environment. No UI dependency failure in the main checkout. Log: `/private/tmp/mama-review-full-suite.log`.
- `./node_modules/.bin/tsc --noEmit`: passed after final source changes. `git diff --check`: passed. All changed TypeScript files formatted with repository Prettier.
- Full-suite failures are retained below, not treated as passing. They existed in the isolated baseline runs and cannot be exercised in this sandbox. No production deployment, actual backend credential-denial execution, real Telegram call, launchd operation, or owner-policy mutation was attempted.

Full-suite failure names:

- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > serves live memory counts from the supplied daemon database and fails explicitly if unwired`
- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > redirects the root and serves the carried operator shell`
- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > maps graph.query browse data to the archive graph response shape`
- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > shows the source text of an observation and the cited evidence of a memory in graph detail`
- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > maps work.list to the archive operator task response shape`
- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > uses the catalog dispatcher for memory search and reports unbound record stores`
- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > serves runtime and connector state through read-only routes`
- `tests/api/viewer-archive-routes.test.ts > archive-compatible viewer routes > does not serve mutating graph routes`
- `tests/api/viewer-records.test.ts > viewer board and wiki record routes > reads the carried board store and configured wiki root`
- `tests/api/viewer-records.test.ts > viewer board and wiki record routes > seeds report events from the same store used by the publisher`
- `tests/api/viewer-server.test.ts > viewer HTTP server > lists tasks through work.list and returns only the task projection`
- `tests/api/viewer-server.test.ts > viewer HTTP server > loads a task history, reads graph evidence, and cites source.read observations`
- `tests/api/viewer-server.test.ts > viewer HTTP server > uses graph.query browse output, filters by generic kind, and reports the absent revision chain`
- `tests/api/viewer-server.test.ts > viewer HTTP server > searches memory through memory.search`
- `tests/api/viewer-server.test.ts > viewer HTTP server > serves the carried viewer shell separately from dispatcher-backed API routes`
- `tests/cli/daemon-boot.test.ts > daemon bootstrap > authenticates MCP list and action calls with the credential written by Claude boot`
- `tests/integration/w1-owner-q1.test.ts > W1 owner question integration > stores source, mailbox, model, tool and work evidence before one Telegram delivery`
- `tests/runtime/action-mcp-server.test.ts > mama action MCP server — credential rotation > re-reads the credential on every stdio request and rejects the revoked token`
- `tests/runtime/owner-runtime.test.ts > owner runtime assembly > routes authenticated Claude socket caller facts to the active native session`
- `tests/runtime/owner-runtime.test.ts > owner runtime assembly > passes the embedder into real knowledge so work.create stores a vector`
- `tests/runtime/owner-runtime.test.ts > owner runtime assembly > lets the owner save a correction under user and connector channel scopes`
- `tests/runtime/stimulus-delivery.test.ts > one stimulus intake and delivery > serializes a source delta and owner message on owner:runtime`
- `tests/runtime/stimulus-delivery.test.ts > one stimulus intake and delivery > does not ack a native turn that throws after native acceptance`

Initial RED logs: `/private/tmp/mama-review-root-red1.log` (F1.13/20/22/23), `mama-review-root-red2.log` (F1.1/3), `mama-review-root-red3.log` (F1.1/9 wiring), `mama-review-outbound-metadata-red.log` (F1.6 missing metadata). Agent RED/GREEN commands and logs are recorded in `/private/tmp/mama-review-security-results.md`, `/private/tmp/mama-review-connectors-results.md`, `/private/tmp/mama-review-telegram-results.md`. Each fixed item had an intended failing assertion before its production repair; unrelated sandbox failures are not counted as RED proof.

Final source changes: +557/−268. Final test changes: +1225/−99. This report is additional documentation.

MAMA decision-save attempt was blocked by the MCP tool: `MCP tool call requires approval, but approval policy is never`. No decision was saved through MCP; the code/contract evidence remains in this report. No approval request or alternate write was attempted.

## Complete file accounting

| File                                                   |   + |   − |
| ------------------------------------------------------ | --: | --: |
| `src/agent/claude-native-tool-policy.ts`               |  11 |   2 |
| `src/api/attachment-actions.ts`                        |  26 |  24 |
| `src/api/cf-access.ts`                                 |  24 |   9 |
| `src/api/file-delivery.ts`                             |  47 |   9 |
| `src/api/security-events.ts`                           |  16 |  12 |
| `src/api/viewer-request-security.ts`                   |   2 |   1 |
| `src/api/viewer-server.ts`                             |   0 |   6 |
| `src/cli/commands/daemon.ts`                           |  34 |  39 |
| `src/cli/commands/replay.ts`                           |   0 |   1 |
| `src/cli/index.ts`                                     |  16 |   5 |
| `src/cli/runtime/claude-caller-config.ts`              |  23 |  38 |
| `src/connectors/chatwork/index.ts`                     |  31 |   2 |
| `src/connectors/framework/attachment-io.ts`            |  18 |   2 |
| `src/connectors/framework/polling-scheduler.ts`        |  14 |   6 |
| `src/connectors/kagemusha/index.ts`                    |   7 |   2 |
| `src/gateways/telegram-attachments.ts`                 |  18 |   4 |
| `src/gateways/telegram-errors.ts`                      |   5 |   0 |
| `src/gateways/telegram-message-ledger.ts`              |  19 |   2 |
| `src/gateways/telegram-response-presenter.ts`          |   5 |   0 |
| `src/gateways/telegram.ts`                             | 107 |  40 |
| `src/replay/kagemusha-import.ts`                       |   3 |   2 |
| `src/replay/replay-feeder.ts`                          |   0 |   6 |
| `src/replay/replay-source-catalog.ts`                  |   4 |   1 |
| `src/replay/trello-import.ts`                          |   1 |   1 |
| `src/runtime/backend-security.ts`                      |   6 |   1 |
| `src/runtime/connectors.ts`                            |  11 |   4 |
| `src/runtime/native-session.ts`                        |  11 |   3 |
| `src/runtime/owner-runtime.ts`                         |  14 |   6 |
| `src/runtime/owner-system-prompt.ts`                   |   2 |   6 |
| `src/runtime/report-prompts.ts`                        |   0 |   1 |
| `src/runtime/report-scheduler.ts`                      |   1 |   1 |
| `src/runtime/stimulus-delivery.ts`                     |  64 |  28 |
| `src/storage/source-archive.ts`                        |  16 |   4 |
| `src/utils/untrusted-content.ts`                       |   1 |   0 |
| `tests/api/attachment-actions.test.ts`                 |  96 |   4 |
| `tests/api/cf-access.test.ts`                          |  31 |   0 |
| `tests/api/viewer-security.test.ts`                    |  61 |  38 |
| `tests/cli/claude-caller-config.test.ts`               |  23 |   8 |
| `tests/cli/cli-errors.test.ts`                         |  26 |   0 |
| `tests/cli/daemon-boot.test.ts`                        |  36 |   9 |
| `tests/cli/daemon-delta-report.test.ts`                |  33 |  10 |
| `tests/cli/daemon-scheduled-report.test.ts`            |  11 |  12 |
| `tests/cli/daemon-service.test.ts`                     |  58 |   0 |
| `tests/connectors/attachment-io.test.ts`               |  28 |   3 |
| `tests/connectors/chatwork.test.ts`                    |  60 |   0 |
| `tests/connectors/framework/polling-scheduler.test.ts` |  49 |   1 |
| `tests/connectors/kagemusha.test.ts`                   |  27 |   0 |
| `tests/gateways/telegram-attachments.test.ts`          |  44 |   2 |
| `tests/gateways/telegram.test.ts`                      | 225 |   4 |
| `tests/replay/collect-only-admission.test.ts`          | 106 |   0 |
| `tests/replay/replay-feeder.test.ts`                   |   1 |   1 |
| `tests/replay/replay-source-catalog.test.ts`           |  12 |   1 |
| `tests/runtime/connectors.test.ts`                     |  32 |   0 |
| `tests/runtime/native-session.test.ts`                 |  10 |   1 |
| `tests/runtime/owner-prompt-boundaries.test.ts`        |  14 |   0 |
| `tests/runtime/owner-recovery.test.ts`                 | 203 |   0 |
| `tests/runtime/owner-runtime-lessons.test.ts`          |   7 |   1 |
| `tests/runtime/owner-security.test.ts`                 |   2 |   1 |
| `tests/runtime/report-scheduler.test.ts`               |  28 |   1 |
| `tests/runtime/stimulus-delivery.test.ts`              |   2 |   2 |
