-- The mailbox that any consumer can use.
--
-- Migration 081 declared the owner-event inbox in the core database: its display
-- lines, its frozen procedure activations, its `OwnerEvent` name. Those are one
-- consumer's vocabulary, and a core that requires them makes "receive something
-- durably" unusable without MAMA's trigger loop. The design's own §5.2 measures
-- exactly that, so W6 was corrected: the mechanism of intake is the core's, the
-- words for what it carries are the product's.
--
-- 081 IS NOT EDITED. It is applied history, and editing an applied migration makes
-- the file and the databases that already ran it say different things. Its two
-- tables stay where they are, and the product's compatibility inbox
-- (standalone/src/operator/owner-event-inbox.ts) keeps draining its own rows from
-- its own store. This migration goes forward instead.
--
-- WHAT TRANSFERS, AND WHAT DELIBERATELY DOES NOT.
--
--   The dedupe horizon transfers. "This id already came in" is a purely mechanical
--   fact with no vocabulary in it, and losing it means a connector's redelivery
--   walks in through the new door as if it were new. Copied INSERT OR IGNORE, so
--   re-running changes nothing.
--
--   The rows do not transfer -- and that is how their attempts and receipts are
--   preserved, not how they are lost. A generic intake has nowhere to put a
--   procedure activation, and moving a row while dropping one would lose a contract
--   the producer froze before its cursor advanced. The compatibility inbox keeps
--   every row, every attempt count and every ack exactly where it already is;
--   producers move to the new door one slice at a time, and each slice's old rows
--   are already drained by the loop that owns them before its caller is deleted.
--   Measured 2026-09-22: core owner_event_inbox 0 rows, operator pending 0 rows,
--   owner_event_inbox_events 12 rows -- those 12 are the whole transfer.

CREATE TABLE IF NOT EXISTS mailbox_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Identity: what the producer calls this stimulus.
  stimulus_id TEXT NOT NULL,
  -- Stated by the producer, one of owner_message / source_delta / scheduled.
  -- NULLABLE with no DEFAULT: a row whose producer stated none reads back as
  -- "not stated", which is true. The host never derives it from the content --
  -- reading a message body to decide what kind of work it is is the
  -- classification this contract removes.
  kind TEXT,
  -- Principal: whose stimulus this is.
  principal_id TEXT NOT NULL,
  -- Source: where it came from, canonical at the producer.
  channel_key TEXT NOT NULL,
  -- Content: the bounded change notice. Never the whole context.
  preview_json TEXT NOT NULL DEFAULT '[]',
  -- Reply: where an answer goes back, when the producer can name one.
  reply_to TEXT,
  -- Coalesce: what may mechanically merge with what, while both are pending.
  coalesce_key TEXT,
  -- Time: when it happened, as against when it was accepted.
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Delivery state, and nothing about the work.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','acked','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_at INTEGER,
  acked_at INTEGER,
  retry_after INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mailbox_inputs_status
  ON mailbox_inputs(status, id);
CREATE INDEX IF NOT EXISTS idx_mailbox_inputs_coalesce
  ON mailbox_inputs(status, coalesce_key);

-- Preserved observation identity, one row per ref. A separate table because refs
-- are the dedupe and cause set: they are queried, not just displayed.
CREATE TABLE IF NOT EXISTS mailbox_input_refs (
  input_id INTEGER NOT NULL REFERENCES mailbox_inputs(id) ON DELETE CASCADE,
  ref_id TEXT NOT NULL,
  observation_ref TEXT,
  PRIMARY KEY (input_id, ref_id)
);

-- The 30-day dedupe horizon. One row per ref ever accepted.
CREATE TABLE IF NOT EXISTS mailbox_seen (
  ref_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mailbox_seen_at ON mailbox_seen(seen_at);

-- When to wake, and for what channel. 081 declared this one already and it was
-- generic from the start -- this daemon's own alarm clock, not anyone's calendar
-- (design §6.3). Repeated IF NOT EXISTS so the generic contract stands on its own
-- rather than on a migration written for one consumer.
CREATE TABLE IF NOT EXISTS mailbox_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mailbox_schedules_due
  ON mailbox_schedules(fired_at, due_at);

-- Carry the horizon forward. 081 created owner_event_inbox_events in this same
-- database, so it is always present here; on an install that never drained a
-- single event it is empty and this is a no-op.
INSERT OR IGNORE INTO mailbox_seen (ref_id, seen_at)
  SELECT event_id, seen_at FROM owner_event_inbox_events;

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('core', 86, 'the mailbox is generic: durable intake, schedule, delivery and ack only');
