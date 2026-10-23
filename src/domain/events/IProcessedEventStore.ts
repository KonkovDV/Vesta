/**
 * Consumer-side deduplication for at-least-once delivery.
 * Layer: Domain (contract). Storage: table processed_events (migration 012).
 */
export interface IProcessedEventStore {
  /** Claims the event for this consumer; false when the consumer already claimed it. */
  claim(consumer: string, eventId: string): Promise<boolean>;

  /** Drops the claim after a failed side effect so that a redelivery runs it again. */
  release(consumer: string, eventId: string): Promise<void>;
}
