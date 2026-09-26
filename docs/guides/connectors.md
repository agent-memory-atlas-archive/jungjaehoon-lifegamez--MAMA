# Connect work sources

Connectors collect evidence for the owner agent. Configure them during
[`mama init`](../start/owner-setup.md), or edit `~/.mama/connectors.json` and
restart the daemon. Telegram conversation access is configured separately.

| Connector   | Reads                                             | Authentication                            |
| ----------- | ------------------------------------------------- | ----------------------------------------- |
| `chatwork`  | Configured room messages and attachments          | `MAMA_CHATWORK_TOKEN`                     |
| `slack`     | Configured channel messages and attachments       | `MAMA_SLACK_TOKEN`                        |
| `trello`    | Configured boards, cards and activity             | `MAMA_TRELLO_KEY` and `MAMA_TRELLO_TOKEN` |
| `kagemusha` | Retained messages and tasks from a local database | Read-only database access                 |
| `calendar`  | Google Calendar primary-calendar events           | Authorized `gws` CLI                      |

Enter token values with `mama secret set <NAME>` in a terminal. Credentials belong
in `auth.env`; the JSON contains only their environment variable names. Restart
through `start.sh` so the daemon loads the updated values.

## Configure a source

Each connector entry has `enabled`, a positive `pollIntervalMinutes`, `channels`,
and `auth`. For example, replace the channel placeholder with your source ID:

```json
{
  "slack": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": {
      "<channel-id>": { "role": "hub", "name": "Work discussion" }
    },
    "auth": { "type": "token", "tokenName": "MAMA_SLACK_TOKEN" }
  }
}
```

Supported channel roles are `truth`, `hub`, `deliverable`, `spoke`, `reference`,
and `ignore`. Use them to describe the source's role; `ignore` excludes it from
collection. They do not determine task ownership or completion. The agent judges
those from the evidence. Setup initially assigns `hub`; review that choice.

For Trello, set each channel's `boardId` to the board to collect. For Kagemusha,
the daemon opens `~/.kagemusha/kagemusha.db` read-only. Channel keys can use
`kagemusha:<origin>:<channel-id>` for retained Kakao, LINE, Telegram or other
configured message sources. This bridge requires that database; it is not a
separate login to those services.

## Enable Calendar

Install `gws`, run `gws auth login` with Calendar read access, and ensure its bin
directory is on the PATH in `~/.mama/start.sh`. Use the single channel key
`calendar` with `auth: { "type": "cli", "cli": "gws", "cliAuthCommand": "gws auth login" }`.
The connector currently reads only the primary calendar. It checks actual Calendar
read permission and collects events from the poll start through 90 days ahead,
including cancellation observations returned by the API.

## Check collection

Open the viewer's Connectors page or request `GET /api/connectors/status` on the
local viewer. Inspect `healthy`, `lastPollTime`, `lastPollCount`, and `error`, then
ask the owner agent about a known recent source change and compare the original.

Without a saved cursor, live collection starts with a one-day lookback. Historical
imports use the separate [replay workflow](replay.md). Chatwork returns only its
latest 100 messages per room, so a busier room can lose coverage between polls.
A successful connection, an empty batch or a task count does not prove complete
collection. Treat gaps separately from “nothing changed.”
