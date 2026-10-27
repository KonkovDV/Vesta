import { Pool } from 'pg';

/**
 * Remembers a finished (consumer, event id) pair in `processed_events`.
 * The row is written only after the handler returns, so a crash before that
 * still delivers the entry again.
 */
export interface ProcessedEventClaim {
  alreadyFinished(consumer: string, eventId: string): Promise<boolean>;
  finish(consumer: string, eventId: string): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresProcessedEventClaim(connectionString: string): ProcessedEventClaim {
  const pool = new Pool({ connectionString, max: 2 });
  return {
    async alreadyFinished(consumer: string, eventId: string): Promise<boolean> {
      const result = await pool.query(
        'SELECT 1 FROM processed_events WHERE consumer = $1 AND event_id = $2',
        [consumer, eventId],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async finish(consumer: string, eventId: string): Promise<void> {
      await pool.query(
        `INSERT INTO processed_events (consumer, event_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [consumer, eventId],
      );
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
