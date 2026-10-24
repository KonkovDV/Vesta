-- ============================================================================
-- 002 — Outbox delivery: backoff, lease fencing, poison-message accounting
-- ============================================================================
-- next_attempt_at  A failed row waits before the next claim (exponential backoff).
--                  now() is STABLE, so the column is added without a table rewrite.
-- lease_token      Written by the claim. Marking PUBLISHED/FAILED requires the same
--                  token, so a worker whose lease expired cannot overwrite the row
--                  another worker has claimed since.
-- ============================================================================

ALTER TABLE outbox.messages
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE outbox.messages
  ADD COLUMN IF NOT EXISTS lease_token TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON outbox.messages (next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'FAILED', 'PROCESSING');
