import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import type { IProcessedEventStore } from '../../domain/events/IProcessedEventStore';

/** processed_events from the baseline migration 001_consolidated.sql. */
export class PostgresProcessedEventStore implements IProcessedEventStore {
  constructor(private readonly db: IDatabaseConnection) {}

  async claim(consumer: string, eventId: string): Promise<boolean> {
    const inserted = await this.db.execute(
      `INSERT INTO processed_events (consumer, event_id)
       VALUES ($1, $2)
       ON CONFLICT (consumer, event_id) DO NOTHING`,
      [consumer, eventId],
    );
    return inserted === 1;
  }

  async release(consumer: string, eventId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM processed_events WHERE consumer = $1 AND event_id = $2',
      [consumer, eventId],
    );
  }
}
