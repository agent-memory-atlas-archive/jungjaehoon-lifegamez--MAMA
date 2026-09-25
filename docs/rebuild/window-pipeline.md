# Day-window pipeline: code → Jev → planner → subagents → verify

Owner checks served: **recognise** (every owner-work message lands on a work item), **attach**
(evidence and the right project), and the speed the owner needs to replay a month and run live.
Owner decision 2026-09-25: use Jev for classification, and let the owner agent plan, distribute
to subagents and verify.

## Evidence (measured 2026-09-25; details in checks.md)

- Hand simulation of the 9/2 window (163 lines) against what the agent recorded: 3 items created
  for 2 deliverables in one turn; one client request tagged with the wrong project (channel ids
  without names); an invoice closed the same day left as waiting; 6 threads missed (a motion asset's review
  cycle, a parts-data delivery, a client schedule request, 2 invoices, a lodging-operations thread); long feedback cut at 280 characters.
- Time per window is model time, not tool time (<3 s tools per window). Judgment steps take 1–2.5
  min (3–8.5k reasoning tokens at max); writing steps 1.5–3 min (7–10k output tokens); short
  lookup steps ~20 s each, re-reading 100–150k tokens.
- The archive Jev pipeline (`scripts/backfill/backfill.mjs`, measured to 91.3% chunking) run on
  9/2: chunking 84 pairs in 1.2 s, attribution of 30 chunks in 1.6 s; it attributed the motion asset and
  the parts-data delivery (both missed by the agent) and separated two sibling assets. It classified
  the invoices, the schedule request, a new client order and the lodging thread as chatter, because its question
  is "about a deliverable?" and its candidates are Trello cards only; it drops chunks whose messages
  are all under 30 characters (65 of 95).
- Codex-native subagents are enabled (`multi_agent = true`) and the host wires
  `createSubagentBridge`; the agent never used one.

## Stages

| Stage            | Owner            | Does                                                                                                                                    | Never                                              |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1 collect        | code             | window messages, channel names, Slack threads, Trello transitions, exact duplicate removal                                              | judge type, sameness or relevance; drop rows       |
| 2 classify       | Jev              | adjacent-message chunking; "owner work or chatter?"; which candidate work item; suspected duplicate pairs                               | say "absent" without candidates; know vocabulary   |
| 3 plan           | owner agent      | read the queue, decide new work (band C), group work for subagents                                                                      | skip the raw text when a band is uncertain         |
| 4 draft          | native subagents | per work group: read the raw (source.read), draft a proposal (status, stage, summary, feedback translation, roles, evidence, wiki text) | be restricted by the host (instructed, not fenced) |
| 5 verify + write | owner agent      | check each proposal against evidence, settle duplicates, write work/wiki/board/lessons                                                  | —                                                  |

Rules carried from the archive: code does the mechanical part, Jev narrows and scores, the agent
decides; vocabulary is owner config (`~/.mama/backfill/vocab.json`), never source.

## Work items

**P1 — Jev client.** Carry `jev()` and `pool()` from `archive/unified-core-2026-09-25:scripts/backfill/lib.mjs`
into `packages/standalone/src/replay/jev-client.ts` (TypeScript port, same retry on 429/529).
Config: `jev.keyFile` (default `~/.mama/jev-key`, never read into logs) and `jev.vocabFile`
(default `~/.mama/backfill/vocab.json`) in `config.yaml`. Done: unit test with an injected
fetch; one live call returns answers.

**P2 — window queue.** Port stages 1–4 of `backfill.mjs` (collect, chunk, attribute, queue) into
`packages/standalone/src/replay/window-queue.ts`, verbatim logic first, with exactly these
changes, each named in the file:

1. The relevance question is "is this chunk owner work (a request, decision, schedule, billing,
   delivery, feedback, or a work-item change) rather than chatter?" instead of "about a
   deliverable?".
2. Candidates are the current work items (commitmentId, title, stage) together with Trello cards
   (±24 h activity ∪ embedding top-K), each with its facts.
3. No length filter: every chunk is classified; short messages stay in their chunk.
4. Times are KST.
5. Suspected duplicates: current work items paired with their embedding neighbours, Jev "same
   deliverable?" per pair.
   Done: run on the 9/2 window of the current testbed; every item of the hand simulation above is in
   band A, B or C, and the report lists what landed in D.

**P3 — stimulus from the queue.** The day-window stimulus renders the queue in place of the flat
message list: A grouped by work item with Jev confidence, B with top-2 candidates, C as possible
new work, suspected duplicate pairs, then D (chatter) as full lines at the end. Every message line
keeps channel name, sender, KST time, observationRef and full text. Done: stimulus test pins each
section; 9/2 rendered size is reported.

**P4 — plan, distribute, verify.** Standing text and window instruction: plan from the queue,
give each work group to a native subagent with its lines and the work item's history, subagents
return proposals and do not write, the owner agent verifies and writes, then board, wiki and
lessons. Done: one live window where at least one subagent ran, its tool calls were authorized
(no `subagent authority unavailable` in daemon.log), and all writes came from the owner run.

**P5 — measure before applying.** Re-run the 9/2 window on a copy of the testbed with P1–P4 and
compare with the hand simulation and with the old run: missed threads, wrong project tags,
duplicates, wall time, model steps. The owner decides from this whether to apply to the remaining
windows or restart from 9/1.

Out of scope here: the live polling path (it reuses the same queue builder after the replay).
