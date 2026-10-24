DROP INDEX IF EXISTS outbox.idx_outbox_due;
ALTER TABLE outbox.messages DROP COLUMN IF EXISTS lease_token;
ALTER TABLE outbox.messages DROP COLUMN IF EXISTS next_attempt_at;
