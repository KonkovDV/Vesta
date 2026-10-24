DROP INDEX IF EXISTS event_store.idx_events_tx_gsn;
ALTER TABLE event_store.events DROP COLUMN IF EXISTS tx_id;
