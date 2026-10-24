-- ============================================================================
-- 004 — Durable positions of journal consumers (MP-K23)
-- ============================================================================
-- A consumer that reads with getCommittedEventsAfter keeps its (tx_id, gsn)
-- cursor here, so a restart continues where it stopped instead of reading the
-- journal from the start. The store only moves a cursor forward.
-- Needs 003 (xid8, PostgreSQL 13 or later).
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_store.consumer_cursors (
  consumer   text PRIMARY KEY,
  tx_id      xid8 NOT NULL,
  gsn        bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
