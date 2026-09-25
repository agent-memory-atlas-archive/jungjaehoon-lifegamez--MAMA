# Day-window pipeline: code → Jev → planner → subagents → verify

Owner checks targeted: **recognise** (every owner-work message lands on a work item), **attach**
(evidence and the right project), and a replay/live speed the owner can use. C1/C2 are still open.
Owner decisions 2026-09-25: classify with Jev; the owner agent plans, distributes to subagents and
verifies. Codex adversarial review applied (checks.md, "Window pipeline evidence and review").

## Evidence

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
- Subagents: `multi_agent = true` (codex-home.ts:434-443); the owner turn supplies `prepareAccess`
  and the child bridge re-issues it (native-session.ts:340-347, native-turn.ts:701-733); every
  replay session so far called only `exec` (0 `spawn_agent`).
- `work.list` returns every item's full values, evidence basis and, with `history: all`, every
  revision: 68 items = 62k characters current, 165k with history; the agent and the viewer call it
  repeatedly.

## Stages

| Stage            | Owner            | Does                                                                                                                  | Never                                                            |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1 collect        | code             | window messages by source identity, channel names, Slack threads, Trello transitions                                  | dedupe by text, judge type/sameness/relevance, drop by length    |
| 2 classify       | Jev              | adjacent-message chunking; owner work or not; which candidate work item; suspected duplicate pairs                    | say "absent" without candidates; know vocabulary                 |
| 3 plan           | owner agent      | read the queue, decide new work, promote or dismiss unresolved lines, group work for subagents                        | skip raw text when a band is uncertain                           |
| 4 draft          | native subagents | per work group: read raw, draft a proposal (status, stage, summary, feedback translation, roles, evidence, wiki text) | — (no host restriction; the instruction says propose, not write) |
| 5 verify + write | owner agent      | check proposals against evidence, settle duplicates, write work/wiki/board/lessons                                    | —                                                                |

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

**P4 — plan, distribute, verify.** Standing text and window instruction: plan from the queue, give
each work group to a native subagent with its lines and the work item's history; subagents return
proposals; the owner agent verifies and writes, then board, wiki and lessons. Acceptance by trace,
not by restriction: child model runs show reads and proposals only, all writes carry the parent
model run (`tool_traces.model_run_id`, child `parent_model_run_id`), and daemon.log has no
`subagent authority unavailable`.

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

Out of scope: the live polling path (reuses the queue builder after the replay).
