# Sharing with members (P2) — work list

Owner decisions 2, 3 and 5 (2026-10-08, [team-flow.md](team-flow.md)): one partition scope per
project with ids of its own; members read granted common work and cannot write it; a member shares
an item in its own turn, and a shared item shows its whole revision history.

The slice as first written had only the member's side. Members read common work only once the owner
binds it to a partition, so the owner's side comes first (P2a). Designed from a read-only Codex
design (2026-10-08) and checked against the code; ships after B1 and its core release.

## P2a — the owner binds common work to a partition (core + product)

| #   | Change                                                                                                                                                                                                                 | Why (code)                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The principal repository lists the active partitions: distinct `project` scopes of active member memory grants                                                                                                         | `listActiveGrants` is per principal                                                                                                        |
| 2   | Owner access: active partitions join `scopes` (write), and `defaultScopes` is pinned to today's `ownerMemoryScopes` output                                                                                             | binding `project:<P>` needs it in write scopes (`boundScopeIdsFor`); without the pin every new owner record would bind every partition     |
| 3   | The member-grant refusal compares against the owner's default set, not all of `ownerAccess.scopes`                                                                                                                     | P1 refuses grants in `ownerAccess.scopes`; with partitions there, every partition grant would fail                                         |
| 4   | The owner binds an item by revising it with explicit scopes including `project:<P>`; A3 keeps them on later revisions                                                                                                  | no new action                                                                                                                              |
| 5   | Core: a commitment revision record is readable by a caller who can read that commitment's head (one predicate over `commitment_assignments`), in graph seeds and nodes, chain summaries and the `work.list` links view | `readWork` already returns every revision's patch; per-record checks refuse the earlier revisions bound only to owner scopes (#445 review) |

Proof: the owner revises an item with explicit scopes including `P`; a member granted `P` lists it,
opens its chain, traverses it, and the links view answers; an owner write without scopes binds
today's set; with no partition in use the owner's reads are byte-identical (work list, graph, recall).

## P2b — a member shares a personal memory record (product)

| #   | Change                                                                                                                                                                                      | Why                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | `memory.share` in the member role: a memory id the member owns (bound only to `user:<member>`), a partition it holds a read grant on, and a reason                                          | per-item consent in the member's own turn                                                                                |
| 2   | The host appends one record bound to `user:<member>` and `project:<P>` whose content holds the item's text and its revision history at sharing time, with a `mentions` link to the original | no read path has to open the personal original; the share outlives B1 erasure of the original, as a shared revision does |
| 3   | The action's description says the whole revision history is shared; a later private revision needs another share                                                                            | decision 5                                                                                                               |
| 4   | Refused: a record not exclusively the caller's, a partition outside its active grants or among the owner's defaults, a call outside the member's own message turn                           |                                                                                                                          |

Proof: the owner and a second member granted `P` read the share and its history; the author's
original is unchanged; a member without the grant sees nothing; every refusal writes nothing; a
replayed share is idempotent.

Rejected: history-admission metadata on the share across six read paths (Codex design option): more
mechanism, and erasing the original would remove what was shared.
