---
title: Read reports and reconcile the board
parent: Guides
nav_order: 7
---

# Read reports and reconcile the board

Ask MAMA for the current situation in your owner chat, then open the viewer's
Board page to compare it with the work ledger. The board is written by the agent.
Each section shows when it was last written, and the header counts open, overdue
and unassigned work.

The four sections are `briefing`, `action_required`, `decisions`, and `pipeline`.
MAMA reads them with `report.read` and publishes HTML with `report.publish`.
When a turn changes work, the agent reads the sections that item is in or leaves
and publishes them again. Only a scheduled full report rewrites all four. A report
you ask for in chat is a text answer and leaves the board as it is.

## What happens after a source change

A source change is handled in one turn that continues from what the agent already
knows. The host attaches up to five open work items that may be related (same
source channel within 14 days, or a similar title). The agent revises or creates
the work item, updates the board sections it affects, adds a dated line to the
topic's wiki page, and then chooses whether to notify you. Its final output ends
with `[notify] <text>` for a message to you or `[ack]` for a quiet
acknowledgement. These are runtime routing markers, not commands you need to send.

An untagged source response is logged but not delivered as a notification. The
agent judges urgency using the source and your saved guidance.

## Set report hours

Report hours are in your timezone (the `timezone` setting; see
[Configuration](../reference/configuration.md)):

```yaml
reports:
  full_report_hours: [8, 13, 18]
  reminder_start_hour: 9
  reminder_end_hour: 21
```

Full reports read `source.recent` since the previous full report (24 hours for the
first one), the complete open `work.list` pipeline, and `schedule.upcoming`
(14 days by default). Recent source lines carry references that can be opened with
`source.read`; a source whose last collection failed is listed with its error. The report names work under each stage,
lists every item waiting for an owner decision, and compares deadlines with
calendar events and holidays. The five parts are key situation today, needs a
response, needs a decision, pipeline, and next actions. The owner schedule appears
under key situation today. An empty activity window is reported plainly, and a
collection failure is never described as no change.

Full reports also rewrite all four board sections, update the topic wiki pages
that changed, and write the day's journal. Reminders read the open pipeline (and
the calendar when the session has not read it), update only `action_required`, and
deliver a short priority reminder. A full-report hour takes precedence over a
reminder. Scheduled report text is requested in Korean.

The scheduler checks every minute. It records an hour as sent only after delivery
through `delivery.reports` succeeds; pending reports prevent another scheduled report
from starting. See the [messengers guide](messengers.md) for route setup.

## Check a discrepancy

Name the affected work and what is wrong in your owner chat. Ask MAMA to compare its
history and original evidence with the board, revise the work if warranted, and
republish the affected view. A publication receipt confirms a board write; it does
not by itself confirm that the content is right or that a Telegram message arrived.
See [Corrections and learning](corrections-and-learning.md) and
[Troubleshooting](troubleshooting.md).
