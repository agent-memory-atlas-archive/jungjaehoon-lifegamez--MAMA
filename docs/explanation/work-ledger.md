---
title: Work ledger
parent: Explanation
nav_order: 6
---

# Work ledger

A work item keeps its current state and the changes that produced it. The agent writes those
changes when they happen, so a later answer can explain the feedback and decisions without
reconstructing everything from old conversations.

## One item, successive revisions

Core stores a work identity in `commitments` and its revision patches in
`commitment_assignments`. Each revision points to the judgment record that explains it. Current
values are calculated by applying the revision patches in order; earlier values remain readable.

`work.create` writes an initial commitment. `work.revise` updates that same commitment using the
`expectedRevision` that the caller read. A concurrent change makes that revision stale and the
write fails; the agent reads the current item before deciding how to revise it. The work change,
judgment and explicit links are committed in the same transaction.

| Revision content                         | Why it matters                                                        |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `topic`, `summary`, optional `reasoning` | What changed and why                                                  |
| `set` and `clear`                        | Fields changed by this revision, without replacing the entire history |
| `links`, `sourceRefs`                    | Relationships and the observations supporting the change              |
| `eventDatetime`                          | When the supporting event happened                                    |
| `recordedAt`                             | When the change was recorded                                          |

`eventDatetime` and record time are distinct. Replay requires an event time within the active
source window; a historical revision must not become a current event merely because it was
imported today.

## Product fields describe the work

MAMA's patch includes title, description, status, stage, priority, deadlines, completion criteria,
assignee, roles, file versions and the latest event. Lifecycle status is one of `pending`,
`in_progress`, `review`, `blocked`, `done` or `cancelled`. The separate `stage` field carries the
work's own stage language. A deadline passing is not a completion event.

Roles can carry a person reference, role, evidence references and a confirmation flag. The agent
judges them from the originals, including handoffs, uploaded files and feedback. A null assignee
is a missing structured value; it is not proof that no one worked on the item. An unconfirmed
role stays explicit until evidence supports it.

Files can carry a locator, version and hash. Preserve the original and record which base version
and request produced a result. These fields support provenance; they do not by themselves prove
that an artifact was verified or delivered.

## Read progressively

| Action                            | Use                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `work.list` with `view=overview`  | Counts and facets across the selected work                                                        |
| `work.list` with `view=items`     | Bounded current-work pages; follow `nextCursor`                                                   |
| `work.list` with `view=detail`    | Up to four items with history, evidence basis and text continuation                               |
| `work.show`                       | One named commitment; compact revision chain by default, full revision patches with `history=all` |
| `memory.search` and `graph.query` | Find related judgment records and follow evidence or work relationships                           |

Item-page cursors bind the filters and read version. If the ledger changes between pages, obtain
a new page sequence rather than combining incompatible snapshots. A page's returned count is not
the whole ledger. Use the detail view's continuation metadata for long text.

## Keep evidence with the revision

Use `derived_from` for an observation supporting a judgment. Explicit relations such as
`supersedes`, `amends`, `refines`, `contradicts`, `builds_on` and `synthesizes` describe how records
relate; `blocks` and `next_action_for` connect work. Similar text or a shared topic does not create
identity or a relationship automatically.

The board and wiki are readable views of this work, not alternate task authorities. Preserve
feedback, role evidence and unresolved points on the revision before summarizing them there.

Contracts and implementation: [product work actions](../../packages/standalone/src/api/work-actions.ts),
[core commitments](../../packages/mama-core/src/knowledge/commitments.ts), and
[core action catalog](../../packages/mama-core/src/api/catalog.ts).
