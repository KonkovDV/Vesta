import {
  IEventStore,
  DomainEvent,
  SaveEventsOptions,
  SaveEventsResult,
  EventStoreStats,
  Snapshot,
  EventStoreError,
} from '../../domain/events/event-store.interface';
import type { SemanticEventResult, EventEmbeddingUpdate } from '../../domain/memory/IEventVectorizer';
import { applyEventUpcastersToArray } from '../../domain/events/event-upcaster-registry';

/**
 * In-Memory Event Store implementation for testing.
 */
export class InMemoryEventStore implements IEventStore {
  private events: DomainEvent[] = [];
  private snapshots: Map<string, Snapshot> = new Map();
  private nextGsn = 1;

  async saveEvents(events: DomainEvent[], options?: SaveEventsOptions): Promise<SaveEventsResult> {
    const savedEvents: Array<{ eventId: string; type: string }> = [];

    for (const event of events) {
      // console.log(`Saving event: ${event.aggregateId} v${event.aggregateVersion}`);
      // Simple concurrency check
      const existingEvents = this.events.filter((e) => e.aggregateId === event.aggregateId);
      const lastEvent = existingEvents[existingEvents.length - 1];
      const expectedVersion = lastEvent ? lastEvent.aggregateVersion + 1 : 1;

      if (event.aggregateVersion === 0) {
          event.aggregateVersion = expectedVersion;
      }

      if (event.aggregateVersion !== expectedVersion) {
        throw EventStoreError.aggregateVersionConflict(
          event.aggregateId,
          expectedVersion,
          event.aggregateVersion
        );
      }

      // Assign global sequence number (GSN) for outbox/gap-detector compatibility.
      if (typeof event.gsn !== 'number') {
        event.gsn = this.nextGsn;
        this.nextGsn += 1;
      } else if (event.gsn >= this.nextGsn) {
        this.nextGsn = event.gsn + 1;
      }

      // Keep legacy alias for observability tools.
      event.eventType = event.type;

      this.events.push(event);
      savedEvents.push({ eventId: event.eventId, type: event.type });
    }

    return {
      success: true,
      savedCount: events.length,
      savedAt: new Date(),
      aggregateVersion: events[events.length - 1].aggregateVersion,
      savedEvents,
    };
  }

  async hasEventOfType(aggregateId: string, eventType: string): Promise<boolean> {
    return this.events.some((event) => event.aggregateId === aggregateId && event.type === eventType);
  }

  async getEvents(aggregateId: string, fromVersion: number = 1): Promise<DomainEvent[]> {
    const filtered = this.events
      .filter((e) => e.aggregateId === aggregateId && e.aggregateVersion >= fromVersion)
      .sort((a, b) => a.aggregateVersion - b.aggregateVersion);
    return applyEventUpcastersToArray(filtered);
  }
 
  async getEventsByCorrelationId(correlationId: string): Promise<DomainEvent[]> {
    const filtered = this.events.filter((e) => e.correlationId === correlationId);
    return applyEventUpcastersToArray(filtered);
  }
 
  async getEventsByCausationId(causationId: string): Promise<DomainEvent[]> {
    const filtered = this.events.filter((e) => e.causationId === causationId);
    return applyEventUpcastersToArray(filtered);
  }
 
  async getEventsByType(eventType: string, fromDate?: Date): Promise<DomainEvent[]> {
    let filtered = this.events.filter((e) => e.type === eventType);
    if (fromDate) {
      filtered = filtered.filter((e) => e.timestamp >= fromDate);
    }
    return applyEventUpcastersToArray(filtered);
  }

  async getEventsByGsnRange(
    fromExclusiveGsn: number | null,
    limit: number,
  ): Promise<DomainEvent[]> {
    const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
    if (effectiveLimit === 0) {
      return [];
    }

    const from = fromExclusiveGsn ?? -1;
    const filtered = this.events
      .filter((e) => typeof e.gsn === 'number' && e.gsn > from)
      .sort((a, b) => (a.gsn ?? 0) - (b.gsn ?? 0))
      .slice(0, effectiveLimit);

    return applyEventUpcastersToArray(filtered);
  }

  async getLatestGsn(): Promise<number | null> {
    const gsns = this.events
      .map((e) => e.gsn)
      .filter((g): g is number => typeof g === 'number');
    if (gsns.length === 0) {
      return null;
    }
    return Math.max(...gsns);
  }

  async getLatestEventVersion(aggregateId: string): Promise<number> {
    const events = await this.getEvents(aggregateId);
    if (events.length === 0) return 0;
    return events[events.length - 1].aggregateVersion;
  }

  async exists(aggregateId: string): Promise<boolean> {
    return this.events.some((e) => e.aggregateId === aggregateId);
  }

  async getEventCount(aggregateId: string): Promise<number> {
    return (await this.getEvents(aggregateId)).length;
  }

  async *getEventStream(aggregateId: string, fromVersion: number = 1): AsyncIterable<DomainEvent> {
    const events = await this.getEvents(aggregateId, fromVersion);
    for (const event of events) {
      yield event;
    }
  }

  async *getEventsByGsnRangeStream(
    fromExclusiveGsn: number | null,
    batchSize: number,
  ): AsyncIterable<DomainEvent[]> {
    const effectiveBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 50;
    let cursor = fromExclusiveGsn;

    while (true) {
      const batch = await this.getEventsByGsnRange(cursor, effectiveBatchSize);
      if (batch.length === 0) break;
      yield batch;
      cursor = batch[batch.length - 1].gsn ?? cursor;
    }
  }

  async getStats(): Promise<EventStoreStats> {
    const uniqueAggregates = new Set(this.events.map((e) => e.aggregateId)).size;
    const eventsByType: Record<string, number> = {};
    this.events.forEach((e) => {
      eventsByType[e.type] = (eventsByType[e.type] || 0) + 1;
    });

    return {
      totalEvents: this.events.length,
      totalAggregates: uniqueAggregates,
      eventsByType,
      averageEventSize: 0, // Not calculated
      lastEventAt: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : undefined,
      totalSize: 0, // Not calculated
      totalSnapshots: this.snapshots.size,
    };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async initialize(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    this.events = [];
    this.snapshots.clear();
    this.nextGsn = 1;
  }

  async saveSnapshot(aggregateId: string, version: number, snapshot: Record<string, unknown>): Promise<void> {
    this.snapshots.set(aggregateId, {
      aggregateId,
      version,
      timestamp: new Date(),
      data: snapshot,
    });
  }

  async loadAggregate(aggregateId: string): Promise<{ snapshot: Snapshot | null; events: DomainEvent[] }> {
    const snapshot = await this.getSnapshot(aggregateId);
    const events = await this.getEvents(aggregateId, snapshot ? snapshot.version + 1 : 1);
    return { snapshot, events };
  }

  async getSnapshot(aggregateId: string, maxVersion?: number): Promise<Snapshot | null> {
    const snapshot = this.snapshots.get(aggregateId);
    if (!snapshot) return null;
    if (maxVersion && snapshot.version > maxVersion) return null;
    return snapshot;
  }

  // ─── Semantic Event Sourcing (Этап 6) ───────────────────

  async updateEventEmbeddings(_updates: EventEmbeddingUpdate[]): Promise<void> {
    // In-memory store: no-op (embeddings not persisted)
  }

  async getSemanticallySimilarEvents(
    _queryVector: number[],
    _limit: number,
    _options?: { namespace?: string; minSimilarity?: number },
  ): Promise<SemanticEventResult[]> {
    // In-memory store: semantic search not supported
    return [];
  }
}
