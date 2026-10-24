-- ============================================================================
-- 003 — Commit-order reads for the event journal (MP-K23)
-- ============================================================================
-- gsn is drawn at INSERT and becomes visible at COMMIT, so a reader that keeps
-- "last gsn" skips an event whose transaction commits after a later one.
-- tx_id records the writing transaction. A reader takes only rows whose
-- transaction is older than the oldest one still running
-- (tx_id < pg_snapshot_xmin(pg_current_snapshot())) and advances a
-- (tx_id, gsn) cursor. Rows written before this file have tx_id 0 and sort first.
-- xid8 needs PostgreSQL 13 or later.
-- ============================================================================

ALTER TABLE event_store.events
  ADD COLUMN IF NOT EXISTS tx_id xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE INDEX IF NOT EXISTS idx_events_tx_gsn
  ON event_store.events (tx_id, gsn);
