# Operating layer in Kagemusha's structure

Companion to [plan.md](plan.md) W22–W26. It holds the evidence, the per-turn comparison and the
decisions; the plan holds only the work items and their checks. Figures come from Kagemusha's
`~/.kagemusha/logs/context-cost-current.jsonl` and server log, and from MAMA's Codex rollouts of
2026-09-28/29. Kagemusha source: `mama-suite/apps/kagemusha/src` (the running working tree). MAMA
source: `packages/standalone/src` at `6738c6941`.

## What differs

Both run one model session behind one serial queue. Kagemusha keeps what enters that session
small, and its host runs each delta through fixed, checked steps. MAMA pours large payloads into the
session and hands each event to the agent as a whole job.

| Measure                        | Kagemusha                                                                                  | MAMA                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Session life                   | one Devin session 09-16 → 09-29: 13 days, 2,484 turns                                      | several a day; 8 compactions on 09-28                            |
| Turn message                   | median 692 chars, capped at 1,600 (`agent-loop.ts:133–136`)                                | delta turn median 3,563, max 40,242                              |
| Session start                  | `[session_start]` 2,441 chars, capped at 2,500 (`session-start-context.ts:24–31`)          | first turn 29,773–35,028                                         |
| Tool text in every turn        | one `code_act` tool, 1,861-char catalog; about 6,300 chars of usage guidance in the prompt | 27 tools: 10,000 description + 38,000 schema                     |
| Tool result reaching the model | median 37, p90 1,084                                                                       | median 1,553, p90 19,898                                         |
| Tool result per turn           | small                                                                                      | delta 11,762; owner 15,093; reminder 32,763; full report 130,412 |
| Input per day                  | about 0.2M chars                                                                           | about 1.5M chars                                                 |
| Delta notify rate              | 104 of 462 batches (22%), 09-22 → 09-28                                                    | 42 of 98 turns (43%), 09-28                                      |
| Delta recording checked        | 480 reconciles passed, 0 failed                                                            | not checked; 63 of 98 turns wrote anything                       |

Why the results are small: `code_act` keeps host data in the sandbox and returns only what the
script returns. `task_list` hands the sandbox a median 43,774 chars and the model gets 636;
`trello_kanban` 9,028 → 924. MAMA's Codex `exec` works the same way, but the agent prints whole
results (`text(r)`), and several MAMA actions return very large payloads (`work.list` pipeline
54,356 chars).

The cycle this creates in MAMA: large results fill the session → it compacts → rules, corrections
and situation are lost → the host pushes 29k chars at session start to compensate → the session
fills faster. The owner decision of 2026-07-16 ("autonomous lanes treat the session as a cache",
measured 146 s → 521 s over three days; `freshSession` in core `native-turn.ts`) was dropped by the
rebuild.

## Kagemusha's loop, as it runs

- **Queue and session.** One `KagemushaAgentLoop` (`agent/agent-loop.ts`), one runner, one
  in-memory FIFO (`:321`). Telegram chat, every awareness step and the session start all call
  `chat()` and wait. The Devin session is reused for the process lifetime
  (`devin-acp-process.ts:151`).
- **Turn text.** `<context channel>` + optional lesson block + previous turns only after a session
  loss (≤3,000 chars) + the message (`:343–400`).
- **Lessons.** None on automation turns. After a new or lost session: top 3 by search, ≤1,200
  chars. Within a session: only on memory-trigger words, with a cooldown, ≤600 chars (68 of 3,342
  turns). Blocks say "lessons, not facts; verify current state with tools" (`:185`).
- **Restore.** Automation turns (`system:`, `delta-taskboard:`, `delta-feedback:`,
  `delta-contract:`) are left out of the transcript restored after a loss; delta notify turns are
  kept (`:138–145, :800`).
- **Session start.** One `[session_start]` turn at startup: 10 owner messages, 10 resumable turns,
  recent decisions, 3 startup lessons, checkpoint, current time, "use channel_recent for what came
  after" (`runtime/agent-session.ts`, `session-start-context.ts`).
- **Delta cycle** (`runtime/agent-awareness.ts:336–540`). A new channel message triggers a flush
  after 15 s (`:322`); a 5-minute timer also runs (`:291`); a running batch makes the next one skip
  (`:343`); compaction pauses deltas 30 s (`:317`). All new messages since the cursor are grouped by
  channel. Per channel: an optional contract turn when a situation pattern matches (21 in 14
  days); feedback forwarding; the **notify turn** (`formatDelta`, `:554`: header with time, source
  ids, one line per message ≤500 chars); the **record turn** (`buildTaskboardReconcilePrompt`,
  `:1050`: read context, tasks and kanban, decide slots, write or `contract_no_update`, "done:"
  line, reply `[ack]`). The record turn is verified by a before/after snapshot: a task or report
  change scoped to the batch's source events, or a no-update record
  (`agent/contracts/action-verifier.ts:231–330`). The cursor advances only over messages whose
  notify and record both passed (`:520–540`).
- **Routing.** The host reads the last `[notify]`/`[ack]` in the reply (`:1033`), the same as MAMA
  (`cli/commands/daemon.ts:395`).
- **Reports.** Full report at 8/13/18 with its own prompt (`runtime/report-prompts.ts:1–16`);
  hourly reminder with Kagemusha's steps (`:1434–1470`); chat "full report" swapped by regex
  (`monitoring-runtime.ts:294`).
- **Learning.** `brain.observeTurn` extracts lessons from owner messages by keyword
  (`brain/experience-signal-extractor.ts`), and `mama_save` saves what a tool cannot re-derive.

## Per-turn table

| Turn                  | Kagemusha                                                      | MAMA now                                                                                                     | After W22–W23                                                                                                                                       |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session start         | `[session_start]` ≤2,500                                       | corrections, pipeline, board and recent exchanges on the first turn, 29–35k (`stimulus-delivery.ts:721–741`) | `[session_start]` block ≤2,500 on a new session: recent owner exchanges, 3 startup lessons, current time, "read the ledger and sources when needed" |
| Owner message         | channel + message; lessons after a restore or on trigger words | bounded stimulus, 288–900 chars                                                                              | channel, local time, top-3 lessons ≤1,200 (owner rejected keyword triggers), message                                                                |
| Chat full report      | regex swap to the report prompt                                | swap only for registered phrases; none registered                                                            | no swap; the one full-report procedure is in the fixed prompt and the agent recognises the request                                                  |
| Scheduled full report | tag, time, reads, publish 4 slots, five parts                  | steps + wiki resync + journal (`report-prompts.ts:68–110`)                                                   | tag, local time, "changes since"; procedure from the fixed prompt; no wiki resync                                                                   |
| Reminder              | task list, top 5–8, `action_required`, 3–6 lines               | own steps + acknowledged-delta digest                                                                        | Kagemusha's steps; `[ack]` allowed when nothing needs attention                                                                                     |
| Delta notify          | messages inline, decide `[notify]`/`[ack]`                     | one all-in-one turn per poll row                                                                             | notify order: header with local time, one line per message ≤500 chars                                                                               |
| Delta record          | fixed 5 steps, `[ack]`, verified                               | none                                                                                                         | record order: 5 steps, `work.no_update` when nothing changed, the case wiki line when a case moved, `[ack]`; verified from `tool_traces`            |
| Tool results          | filtered in the sandbox                                        | whole results printed                                                                                        | usage guidance with filtering examples; compact default results for the largest reads                                                               |

## Instruction paths

| Path                                           | Size now           | After W22                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host prompt (`owner-system-prompt.ts`)         | 13,800             | Kagemusha's section order: role; behaviour (actions over shell, the routing tags, success only on tool success); continuity (session start, compaction recovery, save rule); the full-report procedure; tool usage with filtering examples; messenger syntax. No style, per-kind procedure, replay or delegation lines |
| Telegram guide (`gateways/telegram-format.ts`) | 1,300              | syntax only; "unstyled prose reads better" removed                                                                                                                                                                                                                                                                     |
| `owner-policy.md`                              | 2,700              | the only home of language, style and report-content rules; line 62 fixed (data)                                                                                                                                                                                                                                        |
| Codex skills message                           | 4,700              | the stale `wiki-versioned-publish` skill, which no source produces, is deleted (data)                                                                                                                                                                                                                                  |
| Codex multi-agent messages                     | 2,700              | unchanged; no longer contradicted once the host delegation line goes                                                                                                                                                                                                                                                   |
| Session-start blocks                           | 29,000             | `[session_start]` ≤2,500                                                                                                                                                                                                                                                                                               |
| Turn text                                      | 300–40,000         | the work order, ≤1,600 except message lines the batch carries                                                                                                                                                                                                                                                          |
| Tool descriptions and schemas                  | 48,000             | one line per tool and the input schema; full contract through a `help` action; board content rules move to the full-report procedure                                                                                                                                                                                   |
| Lessons                                        | 5,000–7,000 pushed | top 3 ≤1,200, advisory                                                                                                                                                                                                                                                                                                 |

Known conflicts removed: point form vs "unstyled prose reads better"; "no ids" vs policy line 62;
"no mechanical hourly reports" vs a reminder that always writes; "delegate when it helps" vs Codex
"do not spawn unless asked"; "read each board section first" vs the correction "update the board
without a separate check".

## Removed, and where their knowledge goes

| Removed                                                                                                 | Where it goes                                                                |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| corrections block, correction deltas, guidance state (`stimulus-delivery.ts:583–760`)                   | top-3 lessons; standing rules in `owner-policy.md`                           |
| pipeline and board blocks at session start                                                              | the agent reads `work.list` and `report.read` when needed                    |
| report-phrase mechanism (`report-phrases.ts`, `api/owner-report-phrase-actions.ts`, swap, prompt lines) | the fixed-prompt full-report procedure                                       |
| one turn per poll row; related-work candidates                                                          | notify and record orders; the record order reads the ledger when it needs to |
| acknowledged-delta digest (`acknowledged-source-deltas.ts`)                                             | the reminder reads `work.list`                                               |
| wiki resync and daily journal in the full report                                                        | the case wiki line in the record order                                       |
| replay orchestration and delegation lines                                                               | the replay turn text (W26)                                                   |
| `acceptNativeEvent` (no producer since 2026-09-27)                                                      | none needed                                                                  |

## Deviations from Kagemusha

1. No keyword swap for chat reports and no keyword lesson triggers; the agent decides from context
   (owner, 2026-09-29).
2. Kagemusha's "print a plan block first" is not ported to owner replies (owner correction); the
   checklist stays in the record order, whose reply is never sent.
3. The durable mailbox replaces the in-memory queue. Operator rows pending at a restart are
   quarantined and redone from the uncommitted cursor.
4. The case wiki line is written in the record order (INTENT: history is written when the change
   happens); Kagemusha has no wiki.
5. `brain.observeTurn` keyword extraction and the contract system are not ported: the agent saves
   lessons itself, and contracts ran 21 times in 14 days.
6. Codex keeps its native `exec` as the filter; `code_act` (#332) is not needed for the Codex
   backend. Whether the Claude backend needs it is decided after W22's measurement.

## Owner decisions still open

1. How the agent edits `owner-policy.md` when a correction is a standing rule (owner-message-only
   action recommended). Until then the developer merges such corrections.
2. Feedback forwarding: Kagemusha routes it by keyword. Leave it to the notify order, or port it
   with the agent deciding.
3. Telegram placeholder and streaming (W25).

## Baselines and targets

| Measure                                                    | Baseline        | Target                                 |
| ---------------------------------------------------------- | --------------- | -------------------------------------- |
| Compactions of the owner session per day                   | 8               | ≤1                                     |
| Input chars per day into the owner session                 | about 1.5M      | ≤0.4M                                  |
| Tool result per turn, median (delta / owner)               | 11,762 / 15,093 | ≤3,000                                 |
| Session start message                                      | 29,773          | ≤2,500                                 |
| Record orders that wrote or declared no update             | 63 of 98        | all                                    |
| `[notify]` share of delta batches                          | 43%             | within the owner policy; Kagemusha 22% |
| Chat full report: local date, five parts, sentence endings | wrong / no / 13 | right / yes / 0–1                      |
