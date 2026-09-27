---
title: Read reports and reconcile the board
parent: Guides
nav_order: 7
---

# Read reports and reconcile the board

Ask MAMA for the current situation in the owner Telegram chat, then open the
viewer's Board page to compare it with the work ledger. The board is an
agent-written, dated presentation of work; inspect its update time before treating
it as current.

The four slots are `briefing`, `action_required`, `decisions`, and `pipeline`.
MAMA reads them with `report.read` and publishes HTML with `report.publish`.
Changing a task does not itself rewrite these slots; a board turn must publish
the updated view.

## What happens after a source change

The owner agent reads the new source evidence, updates work as needed, and chooses
whether to notify you. Its final output ends with `[notify] <text>` for an owner
message or `[ack]` for a quiet acknowledgement. These are runtime routing markers,
not commands you need to send.

The host queues a separate board turn after the source turn. That turn reads the
current tasks and board, then republishes all four slots. An untagged source
response is logged but is not delivered as a notification. The agent judges
urgency using the source and saved owner preferences.

## Set report hours

The defaults are Korea Standard Time, regardless of the host's local timezone:

```yaml
reports:
  full_report_hours: [8, 13, 18]
  reminder_start_hour: 9
  reminder_end_hour: 21
```

Full reports read `source.recent` (24 hours by default), the complete open
`work.list` pipeline, and `schedule.upcoming` (14 days by default). Recent source
lines carry references that can be opened with `source.read`; poll failures appear
beside the affected readable channels. The report names work under each stage,
lists every item waiting for an owner decision, and compares deadlines with
calendar events and holidays. The five parts are key situation today, needs a
response, needs a decision, pipeline, and next actions. The owner schedule appears
under key situation today. An empty activity window is reported plainly, and a
collection failure is never described as no change.

Reminders use the same three reads, update changed wiki pages, and publish all
four board slots before delivering a short priority reminder. A full-report hour
takes precedence over a reminder. Scheduled report text is requested in Korean.

The scheduler checks every minute. It records an hour as sent only after delivery
through `delivery.reports` succeeds; pending reports prevent another scheduled report
from starting. See the [messengers guide](messengers.md) for route setup.

## Check a discrepancy

Name the affected work and what is wrong in Telegram. Ask MAMA to compare its
history and original evidence with the board, revise the work if warranted, and
republish the affected view. A publication receipt confirms a board write; it does
not by itself confirm that the content is right or that a Telegram message arrived.
See [Corrections and learning](corrections-and-learning.md) and
[Troubleshooting](troubleshooting.md).
