# Correct MAMA and check what it learns

Tell the owner agent what was wrong, what should change, and where the correction
applies. For example: “For the daily report, put the actions I need to take first.
Keep ordinary answers in their usual order.” A task-specific correction should
identify the affected work and its evidence.

## Store the correction with its scope

The owner instructions require a correction to be saved in the same turn with
`memory.save`, kind `lesson`, and its scope. Live owner messages provide source
provenance; replay lessons must link to the exact original observation.

Memory kinds are `decision`, `preference`, `constraint`, `lesson`, and `fact`.
A correction can replace named earlier memory records through `memory.save`'s
`replaces` field while retaining history. Saving another record with the same
topic does not replace the earlier one. Ask MAMA to reconcile an existing rule
instead of keeping contradictory instructions.

Use `memory.search` to find the saved guidance and `memory.read:provenance` to
inspect its basis. If the correction changes work status, ownership or history,
MAMA also needs to revise that work; a lesson alone does not change the task or
[board](reports-and-board.md).

## Test the next related situation

Each turn recalls up to three relevant lessons, preferences or constraints using
the stimulus text. A new session also receives startup lessons and recent owner
exchanges. Recalled guidance is not treated as proof of current work state; the
agent still needs to read the relevant records and originals.

After a correction:

1. Read back the saved instruction and its scope.
2. Request a related task and check that the result changes as intended.
3. Request an unrelated task and check that the correction has not spread to it.
4. Restart MAMA using the [service procedure](troubleshooting.md#restart-or-stop-a-launchd-service)
   and repeat the related request. Also verify a genuinely new session when testing
   recall; a process restart can resume a persistent backend session.

Saving succeeds when the record is durable. Learning succeeds when the later
result is correct, including after session changes. Inspect the answer, report or
file itself rather than relying on a claim that MAMA remembered.
