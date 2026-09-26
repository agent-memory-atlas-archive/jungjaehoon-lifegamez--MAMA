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

Full reports read recent sources and current work, update the board, and cover
situation, responses needed, decisions, pipeline and next actions. Reminders run
hourly in the inclusive window, select priority work, include gathered non-urgent
changes, and update `action_required`. A full-report hour takes precedence over a
reminder. Scheduled report text is currently requested in Korean.

The scheduler checks every minute. It records an hour as sent only after Telegram
delivery succeeds; pending reports prevent another scheduled report from starting.
Reports depend on the Telegram gateway being enabled.

## Check a discrepancy

Name the affected work and what is wrong in Telegram. Ask MAMA to compare its
history and original evidence with the board, revise the work if warranted, and
republish the affected view. A publication receipt confirms a board write; it does
not by itself confirm that the content is right or that a Telegram message arrived.
See [Corrections and learning](corrections-and-learning.md) and
[Troubleshooting](troubleshooting.md).
