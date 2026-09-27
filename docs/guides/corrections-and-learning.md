# Correct MAMA and check what it learns

Tell the owner agent what was wrong, what should change, and when the correction
applies. For example: “For the daily report, put the actions I need to take first.
Keep ordinary answers in their usual order.” A task-specific correction should
identify the affected work and its evidence.

## Save or revise guidance

At the start of a new owner session, MAMA gives the agent an index of active
lessons, preferences, constraints, and workflows. Each line includes an id,
kind, topic, and the situation where it applies. When an entry applies, the agent
reads the full record with `memory.read:record` before acting.

The agent saves an owner correction or an approved way of working with
`memory.save`. Every lesson, preference, constraint, and workflow needs an
`appliesWhen` line. Use kind `workflow` for a procedure and include its ordered
steps; add `evidenceChecks` when the procedure must check particular evidence.
Use `lesson`, `preference`, or `constraint` for other guidance. Link the owner's
message with a `derived_from` link when its observation reference is available.

To change existing guidance, name it in `memory.save`'s `replaces` field. The old
record stays in history. Use `memory.retire` with a reason when the owner
withdraws guidance or it no longer applies. Retirement changes its status and
keeps the record; it does not delete it. `memory.read:provenance` reads the
record's source links. If a correction changes work status, ownership, or
history, MAMA also needs to revise that work; guidance alone does not change the
[board](reports-and-board.md).

Older guidance may not have an `appliesWhen` line. Its index line shows the
record's summary instead. The agent can revise it when its scope needs to be made
clear.

## When guidance reaches the agent

The full index arrives on the first turn of a new owner session, along with the
recent owner exchanges already carried into that session. Later turns in that
session receive only guidance added, revised, or retired since the last index.
Scheduled reports, source changes, and native events follow the same rule. An
unchanged index produces no extra block.

The agent decides whether an entry applies. Guidance is not evidence of current
work state: the agent still reads the work record and preserved originals when
needed. `memory.read:record` reads the full guidance; `memory.read:provenance`
and `source.read` help check its basis.

## Check the next related situation

After a correction:

1. Read the saved instruction and its scope.
2. Request a related task and check that the result changes as intended.
3. Request an unrelated task and check that the correction has not spread to it.
4. Start a new session and repeat the related request.

Saving succeeds when the record is durable. Learning succeeds when a later
related result is correct without changing unrelated work. Inspect the answer,
report, or file itself rather than relying on a claim that MAMA remembered.
