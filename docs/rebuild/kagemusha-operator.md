# Operating layer in Kagemusha's structure

Companion to [plan.md](plan.md) W22–W27. This file holds the per-turn comparison, the evidence and
the decisions; the plan holds only the work items and their checks.

Kagemusha source: `mama-suite/apps/kagemusha/src` (the running working tree, read 2026-09-29).
MAMA source: `packages/standalone/src` at `6738c6941`.

## Why

MAMA OS hands each event to the agent as a whole job. A connector poll becomes a mailbox row, the
row becomes one turn, and the turn is acked when the model returns. The procedure for every turn
kind sits in one standing prompt. Corrections and state reach the session once, when it is new.
Kagemusha's host instead runs an operator loop that decides when to act, issues a complete work
order for each step, checks the result and only then moves its cursor. The agent judges meaning
inside each order. Both run one model session and one serial queue; the unit of work is what
differs.

Evidence from 2026-09-28/29 (rollouts under `~/.mama/.codex/sessions`):

- The same chat request "full report" got 288 chars at 00:21 (second turn of its session) and
  29,773 chars at 01:40 (first turn). State and corrections are pushed only when `isNewSession`
  (`runtime/stimulus-delivery.ts:721–741`).
- The style correction, saved three times, was ignored in the pushed corrections block (13
  sentence endings) and followed once it became one precise line of `owner-policy.md` in the
  system prompt (1 sentence ending).
- Instructions reach a turn from 7 places: the standing prompt, `owner-policy.md`, Codex's built-in
  developer messages, the corrections block, the session-start data blocks, the turn text and 27
  tool descriptions (50k chars). Five of their lines contradict each other (see Conflicts).
- Delta turns on 09-28: 63 of 98 recorded anything; 42 ended in [notify] although the owner rule
  holds non-urgent changes for the reminder; in sessions mixed with owner chat the replies took 5
  forms (narration then [ack], [notify] mid-text with Markdown, a reminder-style report, Japanese
  text, no reply).
- Subagents: 0 spawns in 476 tool calls. The standing prompt permits delegation; Codex's
  `<multi_agent_mode>` forbids spawning unless explicitly asked.
- Kagemusha on 09-28 ran 97 notify, 112 reconcile, 15 feedback and 14 report turns in one Devin
  session. It does not run fewer turns; its turns are small, single-purpose and checked.
- Kagemusha's `code_act` ran two or more host calls in 3% of 2,545 executions since 09-15; MAMA's
  Codex `exec` already batches 31% of its calls. Batching is not a Kagemusha mechanism (#332 is
  closed on that basis).

## Target structure

| Part                       | Kagemusha                                                                                                                          | MAMA after W22–W27                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Collection                 | channels write `channel_messages` as messages arrive                                                                               | connectors keep polling into `raw_items` and `observation_versions` (unchanged)                                              |
| Operator loop              | `AgentAwareness` (`runtime/agent-awareness.ts`)                                                                                    | new `runtime/operator.ts`, a port of it                                                                                      |
| Cursor                     | `lastSeenId` over `channel_messages` rowid, committed only after success                                                           | rowid of `observation_versions`, stored in the operator state file                                                           |
| Trigger                    | 15 s after a new message (`:322`), every 5 min (`:291`), skipped while a batch runs (`:343`), 30 s pause after compaction (`:317`) | the same, with the connector callback as the trigger                                                                         |
| One queue                  | in-memory FIFO in `agent-loop.ts:321`                                                                                              | the core mailbox, already serial and owner-message first (`stimulus-delivery.ts:785`); the operator awaits each row's result |
| Session                    | one Devin session reused (`devin-acp-process.ts:151`)                                                                              | one Codex/Claude session (unchanged)                                                                                         |
| Turn text                  | a complete work order per kind, current local time included                                                                        | the same, all orders in one file                                                                                             |
| Check                      | reconcile must write or call `contract_no_update` (`:1082`)                                                                        | the record order must write or call `work.no_update`, read from `tool_traces` by model run                                   |
| Restore after session loss | last 10 owner turns; automation turns excluded (`agent-loop.ts:352–380, :800`)                                                     | recent owner exchanges only                                                                                                  |

## Per-turn table

| Turn                    | Kagemusha                                                                                                                                                                                          | MAMA now                                                                                                                                                           | Port                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner message           | `<context channel>` + top-3 brain lessons + message; the last 10 owner turns only after a session loss (`agent-loop.ts:343–400`, `brain/kagemusha-brain.ts`)                                       | `## Bounded stimulus` block (`stimulus-delivery.ts:410`); on a new session also the corrections block, open-work pipeline, board and recent exchanges (`:721–741`) | channel header, current local time, top-3 relevant lessons (memory.search on the message), message and attachments; recent owner exchanges only on a new session |
| Chat full report        | `isFullReportRequest` regex swaps the message for the report prompt (`monitoring-runtime.ts:294`, `report-prompts.ts:18–25`); report principles in the fixed prompt (`system-prompt.ts:223, :237`) | swap only for owner-registered phrases, none registered (`stimulus-delivery.ts:400`, `owner-system-prompt.ts:76–77`)                                               | no swap. The full-report procedure lives once in the fixed prompt; the agent recognises the request from context                                                 |
| Scheduled full report   | `[scheduled_full_report]` + time + reads + `report_publish` of 4 slots + five-part format (`report-prompts.ts:1–16`, `agent-awareness.ts:1407`)                                                    | `fullReportTurn` with steps and a wiki resync and journal (`report-prompts.ts:68–110`)                                                                             | tag, local time and "changes since"; steps are the fixed prompt's procedure; wiki resync and journal removed                                                     |
| Hourly reminder         | task list, top 5–8, `action_required` only, 3–6 lines "top N priorities" (`agent-awareness.ts:1434–1470`)                                                                                          | own steps plus an acknowledged-delta digest (`report-prompts.ts:52–66`, `acknowledged-source-deltas.ts`)                                                           | Kagemusha's steps; digest removed                                                                                                                                |
| Delta notify            | `[delta <room> ~time]` + source event ids + message lines (`agent-awareness.ts:554`); reply must start with [notify] or [ack] (`system-prompt.ts:22`)                                              | one all-in-one turn per poll row; marker parsed from the end (`cli/commands/daemon.ts:395`)                                                                        | notify order only: messages inline, decide [notify]/[ack], nothing else; marker must start the reply                                                             |
| Delta record            | separate `[delta_taskboard_reconcile]` turn: read context, task list and kanban, decide slots, write or `contract_no_update`, "done:" line, reply exactly [ack] (`agent-awareness.ts:1050–1080`)   | none; recording happens (or not) inside the delta turn, procedure in the standing prompt (`owner-system-prompt.ts:115–131`)                                        | record order after each notify, same steps with `work.list`, the Trello source, `report.publish`, the case's wiki line, `work.no_update`; [ack] only; checked    |
| Lessons and corrections | fixed prompt rules; top-3 lessons (1,200 chars) on owner messages; none on automation turns; save rule "only what a tool cannot re-derive"; compaction recovery (`system-prompt.ts:54–68`)         | every active correction pushed at session start and on change (`stimulus-delivery.ts:583–587, :721–760`)                                                           | standing rules in `owner-policy.md`; top-3 on owner messages; save rule and compaction recovery in the fixed prompt                                              |
| Fixed system prompt     | one Korean document: role, behaviour rules, routing tags, memory and compaction, tools, report principles, Telegram format (`agent/system-prompt.ts`)                                              | 16k-char standing prompt holding every turn kind's procedure, replay orchestration and delegation (`owner-system-prompt.ts`) + `owner-policy.md`                   | one English host document in Kagemusha's section order + `owner-policy.md`; no per-kind procedures                                                               |

## Instruction paths (W22)

Every place text reaches the model in a turn, read from the 2026-09-29 01:40 rollout. After W22
each rule topic has exactly one path; the check is the assembled input of each turn kind, dumped
from the rollout, with every rule mapped to one path.

| Path                                                                            | Size (chars)    | Carries now                                                                                                                                       | After W22                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host standing prompt (`owner-system-prompt.ts`)                                 | 13,800          | runtime rules, every turn kind's procedure, response style, replay orchestration, delegation, correction precedence                               | runtime mechanics and the one full-report procedure only; style goes to `owner-policy.md`, procedures to the orders, replay to W26, delegation and precedence removed                                                                                                                                                                                                                                                                                            |
| Telegram format guide, inside the host prompt (`gateways/telegram-format.ts`)   | 1,300           | messenger syntax and "unstyled prose reads better"                                                                                                | messenger syntax only                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `owner-policy.md` (owner data)                                                  | 2,700           | the owner's work and style rules; overlaps the host's response and board lines; line 62 conflicts                                                 | the only home for language, style, answer and report-content rules; line 62 fixed                                                                                                                                                                                                                                                                                                                                                                                |
| Codex skills message                                                            | 4,700           | 5 bundled Codex skills and a stale `wiki-versioned-publish` skill in `~/.mama/.codex/skills` that no source produces                              | stale skill deleted; bundled skills dropped if the app-server has a switch for them (to verify)                                                                                                                                                                                                                                                                                                                                                                  |
| Codex multi-agent messages (`multi_agent = true`, `codex-home.ts:473`)          | 2,700           | "you can spawn" and "do not spawn unless asked"                                                                                                   | unchanged, and no longer contradicted once the host delegation line goes                                                                                                                                                                                                                                                                                                                                                                                         |
| Session-start blocks in the first user message (`stimulus-delivery.ts:721–741`) | 29,000          | corrections, open-work pipeline, board, recent exchanges                                                                                          | recent owner exchanges on a new session only                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Per-turn text                                                                   | 300–3,000       | bounded stimulus; report and reminder steps                                                                                                       | the work order: data and the turn's own constraints only                                                                                                                                                                                                                                                                                                                                                                                                         |
| Tool descriptions and schemas (27 tools)                                        | 10,000 + 38,000 | every tool's full description and schema in every turn; 14 descriptions carry usage rules; `report_publish` (2,400) holds the board content rules | progressive, as Kagemusha does: one `code_act` tool whose description lists 25 functions in one line each (1,861 chars, `mcp/stdio-server.ts:99`), about 6,300 chars of usage guidance in its fixed prompt, and detail through `help()`/`list_tools()` (`mcp/code-act-sandbox.ts:600–660`). MAMA keeps a one-line catalog and the core usage guidance up front; full schemas and details are read on demand; board content rules go to the full-report procedure |
| Top-3 lessons (new)                                                             | up to 1,200     | none                                                                                                                                              | situational lessons only, marked advisory ("verify current state with tools"), as Kagemusha does (`system-prompt.ts:48–50`)                                                                                                                                                                                                                                                                                                                                      |

## Known conflicts (all removed in W22)

| Lines in conflict                                                                                        | Resolution                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `owner-policy.md` point-form reports vs "unstyled prose reads better" (`gateways/telegram-format.ts:91`) | drop the prose line                                          |
| no ids in owner text vs `owner-policy.md` "answer evidence with task and observation ids"                | fix the policy line (owner decision 2026-09-29)              |
| "no mechanical hourly reports" vs a reminder turn that always writes one                                 | the reminder order allows [ack] when nothing needs attention |
| "Delegate when it helps" vs Codex "do not spawn unless asked"                                            | drop the delegation line; separation is by host turns        |
| "read each board section first" vs correction "update the board without a separate check"                | the record order reads the board once and writes             |

## Removed, and where their knowledge goes

| Removed                                                                                                         | Where it goes                                                        |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| session-start corrections block, correction deltas, guidance state (`stimulus-delivery.ts:583–760`)             | top-3 lessons on owner messages; standing rules in `owner-policy.md` |
| session-start pipeline and board blocks                                                                         | orders read `work.list` and `report.read` themselves                 |
| report-phrase mechanism (`report-phrases.ts`, `api/owner-report-phrase-actions.ts`, the swap, two prompt lines) | fixed-prompt full-report procedure                                   |
| one all-in-one turn per poll row; related-work candidates (`relatedWorkCandidates`)                             | notify and record orders; the record order reads the ledger first    |
| acknowledged-delta digest (`acknowledged-source-deltas.ts`)                                                     | the reminder reads `work.list`                                       |
| wiki resync and daily journal in the full report                                                                | the case's wiki line in the record order                             |
| replay orchestration and delegation lines in the standing prompt                                                | the replay turn text (W26)                                           |
| `acceptNativeEvent` (no producer since 2026-09-27)                                                              | none needed                                                          |

## Deviations from Kagemusha

1. No keyword swap for chat reports; the procedure is in the fixed prompt once (owner principle
   2026-09-29: the agent acts from context).
2. Kagemusha's "print a plan block first" (`system-prompt.ts:17`) is not ported to owner-facing
   replies; the owner corrected it ("no unrequested checklists"). The checklist stays in the record
   order, whose reply is never sent.
3. The durable mailbox replaces the in-memory queue. Operator rows still pending at a restart are
   quarantined at start and redone from the uncommitted cursor.
4. The record order carries the batch's observation refs in its payload, because the mailbox
   deduplicates refs already accepted by the notify order.
5. Lessons are attached to every owner message, not on trigger words (owner rejected keywords in
   code; decision `owner_corrections_kagemusha_pull`).
6. The case's wiki line is written in the record order (INTENT: history is written when the change
   happens); Kagemusha has no wiki.

## Owner decisions

1. The agent editing `owner-policy.md` when the owner corrects a standing rule: an
   owner-message-only action (recommended) or a workspace file the agent edits. Until then the
   developer merges such corrections (W24).
2. Kagemusha's feedback-forwarding contract routes by a keyword regex, which the owner rejects.
   Port it with the agent deciding, or leave feedback to the notify order.
3. Decided 2026-09-29 (owner): tool descriptions are progressive and read when needed, not all
   injected. The mechanism is chosen in W22 after checking Codex's `tool_search` feature (set to
   false in `codex-home.ts`) and Claude's deferred MCP tools; otherwise a host `help` action returns
   a tool's full contract.
4. Telegram placeholder and streaming (W25).

## Baselines for the checks

| Measure                                                    | Baseline                          | Source                              |
| ---------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| record turns that wrote or declared no update              | 63 of 98                          | 2026-09-28 08:00 rollout            |
| [notify] replies against the hold rule                     | 42 of 98                          | same                                |
| delta reply forms                                          | 5                                 | 2026-09-28 20:34 and 22:40 rollouts |
| chat full report: local date, five parts, sentence endings | wrong, no, 13 (00:21) / 1 (01:40) | 2026-09-29 rollouts                 |
| input of the same owner request by session position        | 288 vs 29,773 chars               | same                                |
| owner reply wait behind a delta turn                       | not yet measured                  | mailbox claimed/acked times         |
