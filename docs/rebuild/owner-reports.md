# Owner reports, corrections that persist, lookups that find, and the owner agent's shell

Owner checks targeted: **report** (full and delta reports on Telegram), **learn** (a correction still
applies after a session reset), **answer** (found fast, told as a person reads it, no ids) and serving
owner requests that need files. Owner decisions 2026-09-26: the main agent gets a shell; answers carry
no ids; Kagemusha's full report and delta report are ported as they are. Most of this is already solved
in Kagemusha (`~/project/mama-suite/apps/kagemusha`, read-only reference): R1–R6 port its mechanisms,
not its content; R7–R9 are MAMA's own (Kagemusha overwrites task titles and keeps no revision chain).
Evidence: checks.md 2026-09-26 10:16, 10:40, 11:00. Codex review (REVISE, 16 findings) is folded in.

## Kagemusha mechanisms ported (file → what)

| Kagemusha                                                                                                                                                                                                                                                                                                                                                                                         | Mechanism                                                                                                                                                                                                          | MAMA item |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `src/brain/kagemusha-brain.ts:69-78,101-119`, `src/brain/brain-context.ts:12,54-93`                                                                                                                                                                                                                                                                                                               | each eligible turn (internal automation turns excluded, `src/agent/agent-loop.ts:525`): lessons searched with the incoming text, top 3 injected as "lessons, not facts; verify with tools"; startup lesson summary | R3        |
| `src/runtime/agent-awareness.ts:1030-1045` `routeResponse`                                                                                                                                                                                                                                                                                                                                        | final answer's last `[notify]`/`[ack]` tag; `[notify]` text to the owner chat; `[ack]` silent; untagged logged, not sent                                                                                           | R4        |
| `src/runtime/agent-awareness.ts:473-475,524-525` → `reconcileTaskboardForDelta` (`:1182`)                                                                                                                                                                                                                                                                                                         | after each channel delta turn, a second turn that updates the board slots                                                                                                                                          | R4        |
| `src/runtime/agent-awareness.ts:1360-1432`, `src/runtime/report-prompts.ts:1-16`; reminder prompt `src/runtime/agent-awareness.ts:1450-1466`; defaults `src/config/ai-config.ts:134-138`                                                                                                                                                                                                          | full report at `fullReportHours` (8, 13, 18 KST), hourly reminder 9–21 except those hours; an hour counts only after a successful send, else retried next tick                                                     | R5        |
| `src/agent/system-prompt.ts:22-27,92-105`                                                                                                                                                                                                                                                                                                                                                         | delta routing and handling rules in the standing text                                                                                                                                                              | R4        |
| backend native shell (current backend Devin; per-asset scripts in its working directory, e.g. `pdf_to_fb_kr_<asset>_<date>.py`, 40+, latest 9/25); `chatwork_file_download`, `slack_file_download` (`src/tools/feedback-tool-registry.ts:242,281`); `send_telegram_image` (`src/tools/image-tool-registry.ts:190-240`: a file under its files directory, images as photo, .xlsx/.pdf as document) | attachments downloaded, files built with the shell, the file itself sent to the owner. The standing text's "no shell bypass" (`src/agent/system-prompt.ts:12-15`) forbids skipping a required tool, not the shell  | R6        |

Not ported: static workflow contracts and the `forward_feedback` automation; the calendar and lodging
lines of the full report (MAMA has no schedule source — a named gap).

## Work items

**R1 — owner-facing text carries no ids.** Replace the citation sentence in
`owner-system-prompt.ts:63` ("Cite every owner answer with the stable commitmentId and observationRef
handles…") with: answer in sentences a person understands; no commitment, observation, judgment or
channel ids in answers, reports or notifications; the reads are the evidence and stay in `tool_traces`.
Update the pinned test (`tests/runtime/owner-system-prompt.test.ts:44-58`). Done: a Telegram answer has
no id; its model run's traces show the reads.

**R2 — a correction becomes a lesson in the turn it arrives.** Replace the replay-only lesson clause in
`owner-system-prompt.ts:71` with one rule for every turn: when the owner corrects you, save it now with
`memory.save` kind lesson and its scope. The live owner message is not an observation (Telegram enqueues
text only, `gateways/telegram.ts:305-312`), so the lesson carries the host-attested source message ref
that `memory.save` already records (`mama-core/src/memory/api.ts:668-678`); replay lessons keep
derived_from to the observation. Done: prompt test; a live correction produces a lesson row with its
source message ref.

**R3 — lessons reach every turn.** Core: add `kind` to `RecallMemoryOptions`, the suggest options and
`memory.search` input, applied in the vector and FTS candidate queries before the limit
(`mama-core/src/memory/types.ts:113-119`, `api.ts:972-1086`, `catalog.ts:521-563`; the vector path
currently stamps every hit `kind: decision`, `api.ts:1072-1086` — fix it to the stored kind). Product:
`createStimulusDelivery` gets a lesson resolver; before `context.run`
(`runtime/stimulus-delivery.ts:368-403`) it recalls kind lesson with the stimulus text (owner text, or
the delta's message lines, or the report instruction) under the owner's scopes and renders the top 3 as
a `lessons` block with the Kagemusha sentence, each summary through the recall sanitizer and its cap
(`mama-core/src/memory/recall-sanitize.ts:23-45`). The first delivery on a new native thread also gets
the top 3 for "startup operating lessons"; the runner exposes a new-thread signal for it rather than
the host guessing from delivery counts. Done: unit tests (kind filter in both candidate paths; block
rendered; startup block only on a new thread); live: correct the agent on Telegram, restart the daemon,
ask again — the stimulus shows the lesson and the answer follows it.

**R4 — delta report.** Live only. (a) Standing text gets Kagemusha's delta rules: a source delta is
recognised, work is recorded, and the final answer starts with `[notify] <Telegram text>` when the owner
should know or `[ack]`. (b) `stimulus-delivery.ts` renders that routing line on a live source delta.
(c) The daemon wires `onSourceResult` (today only `onOwnerResult`, `daemon.ts:265-305`): the last tag
in `result.response` decides; `[notify]` text goes to the owner chat, `[ack]` and untagged are logged.
(d) The board pass: after a delta turn the host enqueues Kagemusha's board-reconcile turn (update the
four slots with `report.publish` from current work; answer `[ack]`), reusing the board instruction
helper (`operator/board-slot-instructions.ts:72-82`). (e) Destination: new config
`telegram.owner_chat_id`, validated against `allowed_chats`; the daemon gateway port gains
`sendToOwner(text, idempotencyKey)` over `TelegramGateway.sendMessage` (`gateways/telegram.ts:235-241`).
A failed send throws in the callback and the row goes `uncertain` (`mama-core/src/runtime/runtime.ts:
673-678`), the same contract as owner replies today, and is never resent silently. Sends reuse the
gateway's existing `TelegramMessageLedger` and idempotency key (`gateways/telegram.ts:404-418`,
`gateways/telegram-message-ledger.ts:115-167`); no second delivery route (resend-without-rerun) is
built for a failure not yet seen. The failure reason, bounded, reaches `onStimulusFailed` and
daemon.log (today only kind and id are logged, `cli/commands/daemon.ts:139-140,305-307`). Done: routing unit tests
(notify, ack, untagged, tag mid-text); live: a real delta produces a Telegram message or an ack log line,
and the board updates after it; daemon.log clean.

**R5 — full report and reminder.** Config `reports.full_report_hours` (default [8, 13, 18]),
`reports.reminder_start_hour` (9), `reports.reminder_end_hour` (21), KST, added to `W1Config` and
`CONFIG_KEYS` with parser tests (`runtime/config.ts:42-106`). New `runtime/report-scheduler.ts`: a 60 s
tick, started only in the live branch after Telegram starts and stopped before it
(`daemon.ts:235-243`, `353-424`); one report at a time; enqueues a `scheduled` stimulus with payload
`{report: 'full' | 'reminder', hourKey}`. Replace the scheduled no-op (`stimulus-delivery.ts:387-388`,
and its test at `tests/runtime/stimulus-delivery.test.ts:296-311`) with a model turn carrying the ported
instruction: full — read current work, recent sources and the board, publish the four slots with
`report.publish`, return the five-part Telegram report (today's situation, needs response, needs
decision, pipeline, next actions), no ids; reminder — open work by priority then deadline, top 5–8,
update `action_required`, return 3–6 lines. The result callback sends it to the owner chat and only then
writes the hour key to `~/.mama/runtime/report-schedule-state.json` (separate from the slot store,
`owner-runtime.ts:141-143`); a failed send leaves the hour unwritten, so the next tick asks again, as
Kagemusha does. Done: tick tests (hour key after success only, reminder excludes full hours, one at a
time, replay never starts it); live: the next full-report hour delivers to Telegram and the board slots
change.

**R6 — the owner agent's shell, attachments and file delivery (Kagemusha's file path).** Owner decision
2026-09-26 amends the isolation policy: the AGENTS.md "MAMA OS agent isolation" native-tools row and
forbidden list allow the Codex shell for the MAMA owner runtime. Core keeps `shell_tool = false` as its
default; `buildMAMACodexAppServerConfig` takes a `shellTool` option and the product's owner runtime
passes true through the runtime to the driver (`mama-core/src/runtime/drivers/codex-home.ts:418-446`,
`codex-app-server-process.ts:1046-1050`, `runtime-process.ts:38-118`, `standalone/src/runtime/
native-session.ts:167-177`), so a second consumer of core is unchanged. The AGENTS.md exception is
written first, in the same commit. `unified_exec` stays false, sandbox `workspace-write`, approval `never`, escalations declined.
The owner runtime's Codex home serves native subagents and replay turns too — stated, not hidden.
The static TOML's `approval_policy = "on-request"` is overridden per thread by `approvalPolicy:
"never"` (`codex-home.ts:423`, `codex-app-server-process.ts:1210-1216`). Attachments first: the live
Chatwork and Slack connectors store an attachment descriptor in the observation metadata (Chatwork file
id and name; Slack file ids and names) — today Chatwork keeps room/message/account only and Slack drops
`message.files` (`connectors/chatwork/index.ts:134-146`, `connectors/slack/index.ts:107-132`; the
archive keeps arbitrary metadata, `storage/source-archive.ts:18-49`; the import already carries
`slackFileIds`, `replay/kagemusha-import.ts:32-37,385-390`). A download for an observation without a
descriptor fails and says so. Product actions, each in the product catalog and `OWNER_ACTIONS` (`runtime/action-surface.ts:26-43,
141-155`): `source.attachment.download` {observationRef} saves a chatwork or slack attachment the
observation names into `~/.mama/workspace/files/` with the connector's own credentials (Kagemusha
`chatwork_file_download`, `slack_file_download`); `deliver.telegram.file` {path, caption} sends a file
under `~/.mama/workspace/files/` to `telegram.owner_chat_id`, images as photo and other files as
document (Kagemusha `send_telegram_image`), refusing a path outside that directory, a symlink, a
non-regular file or one over Telegram's size limit, idempotent per operation id, through a late-bound
send port from the daemon. Done: tests for each refusal, destination from config, idempotency, and the
core default staying false; live: the owner asks for a feedback PDF's translation as Excel on Telegram
and receives the file; traces show the download, the shell commands and the send.

**R7 — the live chat does not inherit the replay's context.** The live daemon continued the replay's
Codex thread: C1 carried 136k–208k tokens per step, the first step had no cache hit (14 s), and a
compaction fired mid-turn. The owner session key is `owner:runtime`
(`runtime/stimulus-delivery.ts:16`); its Codex record is `<runtimeRoot>/codex-runtime/threads/
<sha256(key)>.json` (`codex-app-server-process.ts:681-687`, `codex-thread-registry.ts:147-149,
261-263`). Replay finalization (after the fence is reached, `cli/commands/replay.ts:151-167`) resets
that session through the driver's existing reset (`codex-app-server-process.ts:843-848`), exposed on
`NativeSessionHandle` next to `stop` (`mama-core/src/runtime/runtime.ts:112-124`), and drops the
`SessionPool` entry; mailbox rows, ledger, wiki, reports and lessons stay. The reset is called after the fence
is reached and before `daemon.stop()`; for the Claude backend the equivalent is dropping its session
record — the reset is exposed per backend, not assumed. A new thread also receives the last owner exchanges (Kagemusha
`src/agent/agent-loop.ts` passes the last 10 turns as `<이전 대화>`): the first delivery on a new thread
renders the last few owner messages and replies from the Telegram ledger. Evidence: after a restart the
agent re-translated the wrong asset because the previous request was gone (checks.md 14:30). Done: after a
replay, the first live owner turn logs a new thread whose first prompt carries the standing text, policy,
recent owner exchanges and the stimulus.

**R8 — work lookup finds what the owner names.** Replace the substring filter
(`api/work-actions.ts:291-305`) with ranked retrieval over title and description: exact and token
matches plus cosine similarity on the same embeddings the window queue computes for work titles
(`replay/window-queue.ts:470-495,514-524`), returning the top matches with their scores; the agent
still decides identity. The action becomes async with an embedder port in its context (`work-actions.ts:25-29`); ranking is
score-descending, ties by most recent update, and a ranked page carries its read version like today's
cursor. `status` accepts a string or a list of statuses (OR) (`work-actions.ts:158-170`, schema
`:652-657`). `ids`
outside `view=detail` is refused (`:577-609`). Done: tests with "<asset-2> SSR1", "<asset-1> SSR1"
and "<asset-1>" all ranking "<asset-1>⑥*SSR*イラスト1" first; one call reads all open statuses;
C1 re-asked reads open work in one call.

**R9 — progress reads return the revision chain.** `work.show` (`mama-core/src/api/catalog.ts:
1766-1786`) defaults to the chain: for each revision `{revision, operation, eventDatetime | null, status, stage,
summary}` — status and stage in effect after that revision (folded from the prefix of `set`/`clear`,
withdraw → cancelled), summary from the revision's judgment record under the caller's access
(`knowledge/commitments.ts:35-43,263-298`); full values stay behind `history: 'all'`. Update the pinned default
(`mama-core/tests/knowledge/commitment-read.test.ts:189-199`). Done: test on a 7-revision item; C2
re-asked tells the rounds in order (9/11 side-hair fix, 9/14 feedback, 9/15 second draft, 9/17 FIX).

Order: R1, R2 (prompt, one commit; done 120516c06), R9, R8, R3, R7, then R4, R5, R6. The daemon
restart for R1/R2 already dropped the replay context, so R7 follows the accuracy items. Each item adds 3–5 lines to
checks.md with its live evidence.

**R10 — the Claude backend has parity with Codex (owner decision 2026-09-26).** Audit (Codex astra, read-only)
found the Claude owner path unproven and broken in the normal daemon. Work list, in order:
(a) MCP credential path: the daemon writes `<home>/runtime/session-credential` (`cli/commands/daemon.ts:167`)
while the action MCP server reads `<home>/session-credential` (`runtime/action-mcp-server.ts:53`), so every
owner action fails authentication on Claude; one path, and a test that runs the real stdio→socket auth.
(b) Turn attribution: MCP action calls carry no model run, gateway call, source message or channel
(`action-mcp-server.ts:100-106`, compare `native-session.ts:333`); Codex's child bridge (child access, parent
model run, receipts) is not wired for Claude children (`native-turn.ts:690-839`, `persistent-cli-adapter.ts`).
(c) Standing and replay text per backend: no `spawn_agent` requirement for Claude (`replay-source-catalog.ts:
385`); images and PDFs through Read. (d) New-thread signal decided before assembling content for both
backends (the Claude process replacement is detected after lessons are assembled, `stimulus-delivery.ts:461`),
and R7's reset exposed for both (`persistent-cli-adapter.ts:298` resetSession). (e) Boundary (owner choice):
both backends write only inside `~/.mama/workspace` and both have web access — Codex turns on `web_search`;
Claude replaces `--dangerously-skip-permissions` with a sandboxed Bash and workspace-only file permissions,
keeping WebFetch/WebSearch, within the AGENTS.md isolation rules. (f) Live proof on Claude: an owner question,
a correction saved and applied after restart, and an attachment turned into a delivered file. Done: (f) with
native input receipts, action traces, DB read-back, Telegram receipt and a clean daemon.log.

R10(e) implementation (2026-09-26): owner Codex opts into live web search; core defaults and the
`workspace-write`/`never` thread policy are unchanged. Owner Claude uses `dontAsk`, required sandboxed
Bash without an unsandboxed retry, project-anchored Edit rules (also covering Write/NotebookEdit),
and a workspace temp directory. Project/local policy is refreshed without removing caller hooks.
Claude 2.1.282 `--help` and `sandbox status` confirm the mode and enabled/strict configuration;
outside-write, symlink, web and subagent execution still need a real CLI turn (R10 f).
Configuration references: [Claude permissions](https://code.claude.com/docs/en/permissions),
[Claude sandbox](https://code.claude.com/docs/en/sandboxing),
[Codex web search configuration](https://developers.openai.com/codex/config-reference/).

**Architecture decision (owner discussion 2026-09-26) — replaces the per-backend approach of R10.** Each
backend CLI keeps its own harness (agent loop, native shell/read/subagents, context management): a host-side
loop under subscription access means a fresh process per turn (the Hermes model) and loses the tools the
model was trained on. MAMA owns one thin common host — intake and push into the session, answer delivery, a
one-turn-at-a-time queue with recovery, per-turn context (lessons, recent turns), policy and records
(isolation, write boundary, turn attribution, receipts). Tool calls (updated by the 16:45 measurement):
Codex keeps app-server dynamicTools and Claude keeps the standalone MCP bridge. Parity is the common host
contract: every call names its turn and caller, with separate access, model runs and receipts for children.
Claude's workspace PreToolUse hook supplies session/tool-use/agent identity; the bridge strips it from
strict action input and forwards it as socket session facts. The daemon binds it to the active native
dispatch and reuses the same child-run factory as Codex. Claude children settle with the parent after
in-flight calls drain; Codex retains its native child terminal events. Push
direction: each CLI's session protocol (Claude persistent stream-json, Codex app-server turn/start); ACP only
when a third backend arrives. Evidence (checks.md 15:35): on Claude, MCP upfront, CLI and deferred MCP gave the
same answers in ~20 s; only schema tokens differed, and deferred loading and a CLI's --help are the same
progressive-disclosure idea. The Codex measurement (checks.md 16:45) rejected the MCP switch: dynamicTools
keeps the faster, model-visible entry. A shared conformance test pins caller attribution and write receipts.
