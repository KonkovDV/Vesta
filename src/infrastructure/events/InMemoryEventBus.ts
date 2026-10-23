import {
  IEventBus,
  EventHandler,
  SubscriptionOptions,
  PublishOptions,
  EventBusMetrics,
  SubscriberInfo,
  DeadLetterEvent,
  EventBusUtils,
} from '../../domain/events/event-bus.interface';
import { DomainEvent } from '../../domain/events/event-store.interface';
import { getOrCreateCounter } from '../../monitoring/index';
import { withConcurrencyLimit, DEFAULT_CONCURRENCY } from '../../core/utils/concurrency-limiter';
import { getConfig } from '../../config';

/**
 * Subscriber entry with WeakRef to prevent memory leaks (P0-002 Fix).
 * WeakRef allows garbage collection when handler is no longer referenced elsewhere.
 */
interface SubscriberEntry {
  id: string;
  handler: WeakRef<EventHandler>;
  options: SubscriptionOptions;
  /** Timestamp for TTL-based cleanup */
  timestamp: number;
}

/**
 * In-Memory Event Bus implementation for testing.
 * Uses WeakRef pattern to prevent subscriber memory leaks (P0-002 Fix).
 */
export class InMemoryEventBus implements IEventBus {
  private subscribers: Map<string, Array<SubscriberEntry>> = new Map();
  private subscriptionInfos: Map<string, SubscriberInfo> = new Map();
  private dlq: DeadLetterEvent[] = [];
  private metrics: EventBusMetrics = {
    eventsPublished: 0,
    eventsFailed: 0,
    averageProcessingTime: 0,
    subscriberCount: 0,
    channelCount: 0,
    uptime: 0,
  };
  private startTime: number = Date.now();
  private readonly maxDlqSize: number;
  /** TTL in milliseconds for subscriber cleanup (5 minutes) */
  private readonly subscriberTtlMs: number;
  private readonly dlqOverflowCounter = getOrCreateCounter(
    'eventbus_dlq_overflow_total',
    'Total number of events evicted from DLQ due to size limit'
  );
  private cleanupCounter = getOrCreateCounter(
    'eventbus_cleanup_dead_refs_total',
    'Total number of dead subscriber references cleaned up'
  );

  constructor(options?: { maxDlqSize?: number; subscriberTtlMs?: number }) {
    this.maxDlqSize = options?.maxDlqSize ?? 100;
    this.subscriberTtlMs = options?.subscriberTtlMs ?? 5 * 60 * 1000; // 5 minutes default
  }

  private addToDlq(event: DeadLetterEvent): void {
    if (this.dlq.length >= this.maxDlqSize) {
      const evicted = this.dlq.shift();
      this.dlqOverflowCounter.inc();
      if (getConfig().env !== 'test') {
        console.warn(
          '[InMemoryEventBus] DLQ overflow: evicted event type=' + String(evicted?.originalEvent.type ?? 'unknown') + ', queueSize=' + String(this.maxDlqSize),
        );
      }
    }
    this.dlq.push(event);
  }

  /**
   * Run cleanup to prune dead subscriber references (P0-002 Fix).
   * Removes entries where WeakRef.deref() returns undefined or TTL expired.
   * Can be called periodically or during subscribe/unsubscribe operations.
   */
  runCleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [eventType, subs] of this.subscribers.entries()) {
      const aliveSubs: SubscriberEntry[] = [];

      for (const sub of subs) {
        const handler = sub.handler.deref();
        const isAlive = handler !== undefined;
        const isExpired = now - sub.timestamp > this.subscriberTtlMs;

        if (isAlive && !isExpired) {
          aliveSubs.push(sub);
        } else {
          cleanedCount++;
          this.subscriptionInfos.delete(sub.id);
        }
      }

      if (aliveSubs.length === 0) {
        this.subscribers.delete(eventType);
        this.metrics.channelCount--;
      } else {
        this.subscribers.set(eventType, aliveSubs);
      }
    }

    if (cleanedCount > 0) {
      this.cleanupCounter.inc(cleanedCount);
      this.metrics.subscriberCount = this.subscriptionInfos.size;
    }
  }

  async publish<T extends DomainEvent>(event: T, options?: PublishOptions): Promise<void> {
    const subs = this.subscribers.get(event.type) || [];
    this.metrics.eventsPublished++;

    // Collect alive handlers and prune dead references (P0-002 Fix)
    const aliveSubs: SubscriberEntry[] = [];
    const handlersToExecute: Array<{ sub: SubscriberEntry; handler: EventHandler }> = [];
    let deadCount = 0;

    for (const sub of subs) {
      const handler = sub.handler.deref();
      if (handler) {
        aliveSubs.push(sub);
        handlersToExecute.push({ sub, handler });
      } else {
        deadCount++;
        this.subscriptionInfos.delete(sub.id);
      }
    }

    // Update subscribers with only alive handlers
    if (deadCount > 0) {
      this.cleanupCounter.inc(deadCount);
      this.metrics.subscriberCount = this.subscriptionInfos.size;
      if (aliveSubs.length === 0) {
        this.subscribers.delete(event.type);
        this.metrics.channelCount--;
      } else {
        this.subscribers.set(event.type, aliveSubs);
      }
    }

    // Bounded concurrency to prevent memory exhaustion (P0-007)
    const concurrency = options?.concurrencyLimit ?? DEFAULT_CONCURRENCY;
    await withConcurrencyLimit(
      handlersToExecute,
      concurrency,
      async ({ sub, handler }) => {
        try {
          await handler(event);
          const info = this.subscriptionInfos.get(sub.id);
          if (info) info.processedCount++;
        } catch (error) {
          this.metrics.eventsFailed++;
          const info = this.subscriptionInfos.get(sub.id);
          if (info) info.errorCount++;

          if (EventBusUtils.shouldUseDeadLetterQueue(error as Error, sub.options)) {
            this.addToDlq({
              originalEvent: event,
              error: {
                message: (error as Error).message,
                stack: (error as Error).stack,
              },
              deadLetterAt: new Date(),
              retryCount: 0,
              lastError: error as Error,
            });
          }
        }
      }
    );
  }

  async publishBatch<T extends DomainEvent>(events: T[], options?: PublishOptions): Promise<void> {
    for (const event of events) {
      await this.publish(event, options);
    }
  }

  async subscribe(
    eventType: string,
    handler: EventHandler,
    options: SubscriptionOptions = {}
  ): Promise<string> {
    // Run periodic cleanup during subscribe to prevent unbounded growth (P0-002 Fix)
    if (Math.random() < 0.01) {
      this.runCleanup();
    }

    let subs = this.subscribers.get(eventType);
    if (!subs) {
      subs = [];
      this.subscribers.set(eventType, subs);
      this.metrics.channelCount++;
    }

    const id = EventBusUtils.generateSubscriptionId();
    const entry: SubscriberEntry = {
      id,
      handler: new WeakRef(handler),
      options,
      timestamp: Date.now(),
    };
    subs.push(entry);

    const info: SubscriberInfo = {
      subscriberId: id,
      eventType,
      // handler omitted - stored as WeakRef in SubscriberEntry to prevent memory leak (A-001)
      options,
      registeredAt: new Date(),
      processedCount: 0,
      errorCount: 0,
    };
    this.subscriptionInfos.set(id, info);
    this.metrics.subscriberCount++;

    return id;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const info = this.subscriptionInfos.get(subscriptionId);
    if (!info) return;

    const subs = this.subscribers.get(info.eventType);
    if (subs) {
      const index = subs.findIndex((s) => s.id === subscriptionId);
      if (index !== -1) {
        subs.splice(index, 1);
        this.metrics.subscriberCount--;
      }

      // Clean up empty channel
      if (subs.length === 0) {
        this.subscribers.delete(info.eventType);
        this.metrics.channelCount--;
      }
    }
    this.subscriptionInfos.delete(subscriptionId);
  }

  async unsubscribeAll(eventType: string): Promise<void> {
    const subs = this.subscribers.get(eventType);
    if (subs) {
      for (const s of subs) {
        this.subscriptionInfos.delete(s.id);
      }
      this.metrics.subscriberCount -= subs.length;
      this.subscribers.delete(eventType);
      this.metrics.channelCount--;
    }
  }

  async isSubscribed(subscriptionId: string): Promise<boolean> {
    return this.subscriptionInfos.has(subscriptionId);
  }

  async getSubscriberCount(eventType: string): Promise<number> {
    const subs = this.subscribers.get(eventType);
    if (!subs) return 0;

    // Count only alive handlers and valid subscription infos
    let count = 0;
    for (const sub of subs) {
      // Check subscription info exists first (strong reference)
      if (this.subscriptionInfos.has(sub.id) && sub.handler.deref() !== undefined) {
        count++;
      }
    }
    return count;
  }

  async getSubscriberInfo(subscriptionId: string): Promise<SubscriberInfo | null> {
    return this.subscriptionInfos.get(subscriptionId) || null;
  }

  async getAllSubscriptions(): Promise<SubscriberInfo[]> {
    return Array.from(this.subscriptionInfos.values());
  }

  async getMetrics(): Promise<EventBusMetrics> {
    return {
      ...this.metrics,
      uptime: Date.now() - this.startTime,
    };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async getDeadLetterQueue(eventType?: string, limit?: number): Promise<DeadLetterEvent[]> {
    let events = this.dlq;
    if (eventType) {
      events = events.filter((e) => e.originalEvent.type === eventType);
    }
    if (limit) {
      events = events.slice(0, limit);
    }
    return events;
  }

  async replayDeadLetterEvent(deadLetterEvent: DeadLetterEvent): Promise<void> {
    await this.publish(deadLetterEvent.originalEvent);
  }

  async clearDeadLetterQueue(eventType?: string): Promise<void> {
    if (eventType) {
      this.dlq = this.dlq.filter((e) => e.originalEvent.type !== eventType);
    } else {
      this.dlq = [];
    }
  }

  async initialize(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    this.subscribers.clear();
    this.subscriptionInfos.clear();
    this.dlq = [];
  }
}
