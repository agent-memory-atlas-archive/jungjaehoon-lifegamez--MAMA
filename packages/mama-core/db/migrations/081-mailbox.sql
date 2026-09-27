-- The owner-event mailbox moves into the core database.
--
-- These two tables have existed since the operator loop was built, but only ever
-- inside the product's own triggers.db, created inline by the class that used them.
-- Declaring them here is what lets the mailbox be opened against the core database
-- like every other core store. The shape is the one the live table already has,
-- including the three columns that were added by run-time ALTERs rather than by a
-- migration: retry_after, unresolved_reason and event_refs_json.
--
-- Existing rows are NOT moved here. A .sql migration cannot name another database
-- file, and the rows live in a path only the product knows. scripts/move-mailbox-rows.ts
-- does that part.

CREATE TABLE IF NOT EXISTS owner_event_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  event_refs_json TEXT NOT NULL DEFAULT '[]',
  lines_json TEXT NOT NULL,
  activations_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','acked','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  acked_at INTEGER,
  retry_after INTEGER,
  unresolved_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_owner_event_inbox_status
  ON owner_event_inbox(status, id);

-- Dedupe horizon. One row per event id ever drained, pruned on a 30-day window.
CREATE TABLE IF NOT EXISTS owner_event_inbox_events (
  event_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_owner_event_inbox_events_seen
  ON owner_event_inbox_events(seen_at);

-- When to wake, and for what. Nothing reads this yet: the design puts the reader
-- in 7.3, where the cron scheduler learns to wake from this table instead of from
-- config held in memory. The columns are only what that sentence states the table
-- is for -- which channel, when it is due, whether it fired. Anything else would be
-- a guess at the reader's needs, and a guess costs a second migration.
CREATE TABLE IF NOT EXISTS mailbox_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mailbox_schedules_due
  ON mailbox_schedules(fired_at, due_at);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (81, 'Owner-event mailbox tables move into the core database');
