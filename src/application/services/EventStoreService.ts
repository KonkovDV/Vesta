/**
 * Event Store Service
 *
 * Layer: Application
 *
 * A high-level service for appending and retrieving events.
 * It coordinates with the underlying IEventStore and IOutbox infrastructure services.
 */

import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import type { IOutbox } from '../../domain/events/outbox.interface';

export class EventStoreService {
  constructor(
    private readonly eventStore: IEventStore,
    private readonly outbox: IOutbox,
  ) {}

  /**
   * Append a single event or multiple events to the store.
   * If an outbox is present (and transactional), it might be used implicitly by the infra,
   * but here we just delegate to the main store or outbox depending on strategy.
   *
   * For simplicity in this restoration, we delegate to IEventStore directly.
   */
  async appendEvent(event: DomainEvent): Promise<void> {
    await this.eventStore.saveEvents([event]);
  }

  async appendEvents(events: DomainEvent[]): Promise<void> {
    await this.eventStore.saveEvents(events);
  }

  async saveDomainEvents(events: DomainEvent[]): Promise<void> {
    return this.appendEvents(events);
  }

  async getEvents(aggregateId: string): Promise<DomainEvent[]> {
    return this.eventStore.getEvents(aggregateId);
  }

  async getEventsByAggregateId(aggregateId: string): Promise<DomainEvent[]> {
    return this.getEvents(aggregateId);
  }

  async getLatestGsn(): Promise<number | null> {
    return this.eventStore.getLatestGsn();
  }

  async getEventsByGsnRange(fromExclusiveGsn: number | null, limit: number): Promise<DomainEvent[]> {
    return this.eventStore.getEventsByGsnRange(fromExclusiveGsn, limit);
  }

  async getEventsByCorrelationId(correlationId: string): Promise<DomainEvent[]> {
    return this.eventStore.getEventsByCorrelationId(correlationId);
  }
}
