# INTENT v7 development checks

Use this procedure to evaluate changes against [INTENT.md](../../INTENT.md). These checks are
development evidence, not a host-side approval gate or a replacement for an owner turn.

## Done means

Use the stable IDs below in plans, reviews, checkpoints, and the
[check log](../../docs/rebuild/checks.md).

| ID  | Success criterion                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The owner asks "Who is working on what right now?" about September data and receives a cited answer.                                        |
| C2  | The owner asks "How did X progress, and what was the feedback?" and receives a cited answer from stored task history.                       |
| C3  | The owner asks "Was there a similar case before? How did it go?" and receives a cited past case with its feedback and outcome.              |
| C4  | The scheduled reports and board show the same state as the task ledger.                                                                     |
| C5  | An owner correction changes the next relevant turn, leaves unrelated turns unchanged, and survives restart.                                 |
| C6  | A packed core installed in a temporary directory opens its own database and uses public exports to write, revise, link, and search records. |

## Evidence levels

- **unit** — an isolated function or module test.
- **integration** — several packages or runtime boundaries exercised together.
- **installed daemon** — the installed process runs with a clean daemon log and a database read-back.
- **real owner turn** — a real owner question or correction on real data, observed through delivery and read-back.

Record the strongest level actually observed; do not promote a lower level by inference.

## Procedure

1. At the start, name the relevant C IDs and the user-visible change they should prove.
2. Run the smallest useful evidence first, then the installed-daemon and real-owner checks required by those IDs.
3. Record the command, result, evidence level, and remaining failure in `docs/rebuild/checks.md`.
4. Use exactly one verdict for each check: **met**, **partial**, **not met**, or **unverified**.
5. Keep subtask completion separate from completion of the overall INTENT purpose.
