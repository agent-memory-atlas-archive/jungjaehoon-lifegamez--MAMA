# Day-window pipeline: code → Jev → planner → subagents → verify

Owner checks targeted: **recognise** (every owner-work message lands on a work item), **attach**
(evidence and the right work), and a replay/live speed the owner can use. P0–P4 are implemented;
the replay completed 25 windows. C1/C2 were exercised live and improved by R8/R9, with remaining
omissions, attribution and continuity checks recorded in [checks.md](checks.md) and
[owner reports](owner-reports.md). This is not full owner-check completion.
Owner decisions 2026-09-25: classify with Jev; the owner agent plans, distributes to subagents and
verifies. Codex adversarial review applied (checks.md, "Window pipeline evidence and review").

## Initial evidence and subsequent results

Artifacts live in the testbed, not the repo (they contain business content):
`~/.mama/runtime/measurements/2026-09-25/`. Method and numbers are in checks.md.

- 9/2 hand simulation vs the agent's record (`hand-simulation-0902.md`, `window-0902-lines.txt`):
  10 expected work movements; the agent (low effort, old input) created 3 items for 2 deliverables,
  mis-tagged one project, left a same-day-closed invoice waiting, and missed 5 movements.
- Step timing (`codex-step-timings.json`): tools < 3 s per window; judgment steps 1–2.5 min at max
  effort, writing steps 1.5–3 min, lookup steps ~20 s re-reading 100–150k tokens.
- The archive Jev pipeline on 9/2 (`jev-archive-pipeline-0902-queue.md`): 84 pair judgments in
  1.2 s, 30 attributions in 1.6 s; two movements the agent missed were attributed; invoices, a
  schedule request, a new order and a lodging thread fell to its "not a deliverable" band.
- Initial runs did not dispatch native children. After P4, the 2026-09-26 05:10 read-back recorded
  233 child writes, each tied to a model run. Later Claude parity checks recorded two children within
  one parent turn. Caller access and receipts remain part of the shared host contract.
- Before P0, repeated full-ledger reads were large: 68 items = 62k characters current, 165k with
  history. Progressive views now separate counts, compact items and detail; current revisions also
  travel with queue candidates so the parent need not list the full ledger again.

## Stages

| Stage                 | Owner            | Does                                                                                               | Never                                                         |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1 collect             | code             | window messages by source identity, channel names, Slack threads, Trello transitions               | dedupe by text, judge type/sameness/relevance, drop by length |
| 2 classify            | Jev              | adjacent-message chunking; owner work or not; which candidate work item; suspected duplicate pairs | say "absent" without candidates; know vocabulary              |
| 3 plan                | owner agent      | read the queue, decide new work, promote or dismiss unresolved lines, group work for subagents     | skip raw text when a band is uncertain                        |
| 4 write assigned work | native subagents | read assigned evidence, revise work, update assigned wiki/journal sections, return receipts        | decide another lane's work without coordination               |
| 5 verify + reconcile  | owner agent      | read back changes, reconcile receipts, settle gaps/duplicates, publish board and lessons           | —                                                             |

Rule carried from the archive README: code does the mechanical part, Jev narrows and scores, the
agent decides; vocabulary is owner config (`~/.mama/backfill/vocab.json`). The archive code broke
this rule in places, so it is not ported verbatim: first-80-character text dedup, propagating one
exact card match to a whole chunk, and the 8- and 30-character filters are not carried; an exact
code or name match becomes a candidate hint for Jev and the agent.

## Work items

**P0 — progressive `work.list`.** Carry the archive's view contract
(`archive/unified-core-2026-09-25:packages/standalone/src/api/work-actions.ts`: `overview` counts,
`items` compact rows 25 default / 50 max with a read-version cursor, `detail` up to 4 ids with full
values, history and text continuation) onto the current commitment reader. Filters: status, stage,
project, text over title/description. Evidence basis and revision history only in `detail`. The
viewer uses `items`/`detail`. Done: an `items` page of 25 is at most 6k characters; a ledger change
between pages is rejected with restart guidance; viewer tests pass.

**P1 — Jev client.** `packages/standalone/src/replay/jev-client.ts` from the archive `jev()`/`pool()`
(retry on 429/529). A batch that still fails stops the window as incomplete, naming its observation
refs; an undefined verdict is never read as a boundary or an absence. Config `jev.keyFile` (default
`~/.mama/jev-key`, never logged) and `jev.vocabFile` (default `~/.mama/backfill/vocab.json`).
Done: unit tests with an injected fetch for success, retry, and incomplete stop; one live call.

**P2 — window queue.** `packages/standalone/src/replay/window-queue.ts`, carrying the archive's
plumbing and data shapes, with:

1. Relevance: "is this chunk owner work (request, decision, schedule, billing, delivery, feedback,
   or a work-item change) rather than chatter?"
2. Candidates: the as-of work items (open and closed: commitmentId, title, stage, status) together
   with Trello cards (±24 h activity ∪ embedding top-K), each with facts. Candidate generation only;
   identity stays with the agent.
3. No length filters; source-identity dedup only.
4. KST for display and window boundaries; source times stay epoch.
5. Suspected duplicates: work items paired with embedding neighbours, Jev "same deliverable?" per
   pair; no gate, the agent settles.
   Done: on the 9/2 window every movement of the hand simulation is in A, B or C, and the report lists
   the unresolved band.

**P3 — stimulus from the queue.** Sections: A grouped by work item with Jev confidence, B with
top-2, C possible new work, suspected duplicates, then **unresolved** (low-confidence, full lines).
Every line keeps channel name, sender, KST time, observationRef and full text. Done: stimulus test
pins each section; 9/2 rendered size reported.

**P4 — plan, distribute, verify (implemented; revised during replay).** The parent assigns disjoint
work items, wiki pages and journal headings. Native children write their assigned work and return
receipts with revisions, pages and journal entries. The parent reads back `changedSince`, reconciles
receipts, resolves gaps and duplicates, and publishes the board, Home.md, judgment and lessons.
Traces attribute child writes to child model runs linked to the parent. The original proposal-only
instruction was replaced; it is not a host restriction. See the 02:05–03:44 and 05:10 entries in
[the replay log](checks.md#replay-restart-on-the-window-pipeline--2026-09-25-2240-kst).

**P4 additions (owner review of the viewer and wiki, 2026-09-25).**

1. Relations: the work link contract and the standing text offer the core's relations
   (derived_from, supersedes, amends, refines, contradicts, builds_on, synthesizes, blocks,
   next_action_for); the agent chooses, code never links.
2. Provenance: `memory.read:provenance` joins the owner catalog; the standing text traces a memory
   found by `memory.search` to its cited source messages with it.
3. Viewer: graph detail reads an observation's text through `source.read` and a memory's cited
   excerpts through `memory.read:provenance`, with the earlier records it links; observation
   labels show time and connector instead of the source id.
4. Daily journal: `daily/YYYY-MM-DD.md` per window, written by the agent.
5. Wiki structure: the agent reads Home.md first and places changes into the page they belong to
   (project, client or long-running topic, not one page per task); a new page is listed in Home.md
   in the same publish. The host no longer appends to index.md.

**P5 — fair measurement before applying.** Same 9/2 window, same observation-ref manifest, same DB
snapshot, same model/effort/prompt, three arms: current pipeline; P0–P3; P0–P4. Gold labels: the
hand simulation, confirmed by the owner. Report per arm: recall of movements, wrong attribution,
duplicates, unresolved lines promoted, citation faithfulness, wall time, model steps, total model
and Jev tokens. The owner decides from this whether to apply to the remaining windows or restart
from 9/1.

**P5 result / remaining gap:** the live P2 queue covered all 10 hand-simulation movements in
12 seconds. On 2026-09-25 22:40 the owner chose to restart from 9/1 on the merged pipeline;
25 windows completed at 2026-09-26 05:10. These runs changed effort and instructions, so they
are not the controlled three-arm comparison specified above. No complete three-arm result is
recorded. Coverage, journal/source fidelity and the remaining owner-answer failures are in
[checks.md](checks.md#replay-restart-on-the-window-pipeline--2026-09-25-2240-kst).

Out of scope for this replay work: replacing the live polling path with the queue builder.
Live deltas and board/report routing are documented in [owner reports](owner-reports.md).
