---
title: Correct MAMA and check what it learns
parent: Guides
nav_order: 4
---

# Correct MAMA and check what it learns

Tell the owner agent what was wrong, what should change, and when the correction
applies. For example: “For the daily report, put the actions I need to take first.
Keep ordinary answers in their usual order.” A task-specific correction should
identify the affected work and its evidence.

## How a correction is applied and kept

When you correct MAMA, the agent applies the correction to the current work in the
same turn: it revises the affected work items and board sections, reading the
originals it needs, and only then replies. It does not answer with a promise for
something it can do now.

It then keeps the correction as a lesson, preference, constraint, or workflow,
saved with `memory.save` and an `appliesWhen` line. Use kind `workflow` for a
procedure and include its ordered steps; add `evidenceChecks` when the procedure
must check particular evidence. The agent compares a new correction with the ones
it already has. When it belongs with an earlier one, the agent revises that
record with `replaces`, keeping every earlier point you have not withdrawn or
replaced; otherwise it saves a new one. It links your message with a
`derived_from` link when its observation reference is available. A request you
mark as for this time only is applied to that answer and not saved.

The old record stays in history. Use `memory.retire` with a reason when you
withdraw a correction or it no longer applies; retirement changes its status and
keeps the record. `memory.read:provenance` reads the record's source links.

## When corrections reach the agent

MAMA's built-in instructions for source changes, hourly reminders, full reports,
and answers form one rule set that the agent holds for every kind of turn,
together with the messenger's formatting rules. A report you ask for in chat
follows the same instructions as the scheduled full report.

Every active correction is shown to the agent in full (its summary, the situation
where it applies, and its steps) on the first turn of a new owner session, along
with the recent owner exchanges carried into that session. Later turns receive a
correction again, in full, whenever it is added or revised, and a note when it is
retired. Corrections take precedence over the built-in instructions wherever they
fit, whichever kind of turn they came from.

The agent decides whether a correction applies. A correction is not evidence of
current work state: the agent still reads the work record and preserved originals
when needed.

## Check the next related situation

After a correction:

1. Read the saved instruction and its scope.
2. Request a related task and check that the result changes as intended.
3. Request an unrelated task and check that the correction has not spread to it.
4. Start a new session and repeat the related request.

Saving succeeds when the record is durable. Learning succeeds when a later
related result is correct without changing unrelated work. Inspect the answer,
report, or file itself rather than relying on a claim that MAMA remembered.
