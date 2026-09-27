---
title: Messengers
parent: Guides
nav_order: 1
---

# Talk to MAMA on Telegram, Discord, or Slack

MAMA accepts owner messages through enabled Telegram, Discord, and Slack gateways. A direct reply returns through the gateway that accepted the message. Scheduled reports, `[notify]` results, and viewer security alerts each use their configured single messenger route.

## Configure an owner gateway

`mama init` asks whether to enable optional Discord and Slack owner gateways and stores their credentials in `~/.mama/auth.env`, never in YAML. Telegram uses `MAMA_TELEGRAM_TOKEN`; Discord uses `MAMA_DISCORD_TOKEN`; Slack uses `MAMA_SLACK_TOKEN` and `MAMA_SLACK_APP_TOKEN` for Socket Mode. Set or rotate these with the CLI secret command when needed.

Each enabled gateway requires an owner destination and allowlists. Telegram uses `owner_chat_id`, `allowed_chats`, and `owner_user_ids`. Discord and Slack use `owner_channel_id`, `allowed_channels`, and `owner_user_ids`. A DM channel is a channel for the owner check. Messages from other senders are dropped before the owner session and the daemon logs hashed channel and sender IDs.

```yaml
discord:
  enabled: true
  owner_channel_id: 'channel_test'
  allowed_channels: ['channel_test']
  owner_user_ids: ['user_test']
slack:
  enabled: false
  owner_channel_id: ''
  allowed_channels: []
  owner_user_ids: []
delivery:
  reports: telegram
  notifications: discord
  security_alerts: telegram
```

Every delivery route must name an enabled gateway with an allowlisted owner destination. A bad route stops daemon startup instead of sending through another gateway.

## Attachments and replies

Owner attachments are saved to the daemon-owned `~/.mama/downloads/<messenger>/` directory. The owner agent can read those files but cannot write there. Copy a file into `~/.mama/workspace/files/` before modifying or sending it. Use the matching `deliver.telegram.file`, `deliver.discord.file`, or `deliver.slack.file` action; its receipt prevents a completed operation from being sent again.

The daemon records accepted input, response state, chunk progress, destinations, and send uncertainty in one durable owner-message ledger. On restart, known-unsent replies resume; an ambiguous send remains marked uncertain for reconciliation.
