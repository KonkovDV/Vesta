/**
 * Redis Streams event bus.
 * XADD keeps the entry when no consumer is running. A handler that does not
 * acknowledge leaves the entry pending, and the next consumer claims it.
 */
import Redis from 'ioredis';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import {
  EventBusError,
  EventBusUtils,
  type DeadLetterEvent,
  type EventBusMetrics,
  type EventHandler,
  type IEventBus,
  type PublishOptions,
  type SubscriberInfo,
  type SubscriptionOptions,
} from '../../domain/events/event-bus.interface';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { IdGenerator } from '../../core/utils/IdGenerator';
import type { ProcessedEventClaim } from './processed-event-claim';

interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export interface RedisStreamsEventBusOptions {
  connection: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
  };
  keyPrefix?: string;
  groupName?: string;
  maxLen?: number;
  maxDeliveries?: number;
  /** Pending entries idle at least this long are claimed. 0 claims immediately. */
  minIdleMs?: number;
  pollMs?: number;
  claim?: ProcessedEventClaim;
}

interface StoredBody {
  eventId: string;
  eventType: string;
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  causationId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: { message: string };
  retryCount?: number;
}

export class RedisStreamsEventBus implements IEventBus {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly groupName: string;
  private readonly maxLen: number;
  private readonly maxDeliveries: number;
  private readonly minIdleMs: number;
  private readonly pollMs: number;
  private readonly claim?: ProcessedEventClaim;
  private readonly consumerName = `c-${IdGenerator.generateWithPrefix('stream')}`;
  private readonly subscriptions = new Map<string, SubscriberInfo>();
  private readonly handlers = new Map<string, Map<string, EventHandler>>();
  private readonly attempts = new Map<string, number>();
  private readonly dlqTypes = new Set<string>();
  private metrics: EventBusMetrics = {
    eventsPublished: 0,
    eventsFailed: 0,
    averageProcessingTime: 0,
    subscriberCount: 0,
    channelCount: 0,
    uptime: 0,
  };
  private readonly startedAt = Date.now();
  private initialized = false;
  private closed = false;
  private stop = false;
  private loop: Promise<void> | null = null;

  constructor(options: RedisStreamsEventBusOptions) {
    this.prefix = options.keyPrefix && options.keyPrefix.length > 0 ? options.keyPrefix : 'microphoenix:';
    this.groupName = options.groupName && options.groupName.length > 0 ? options.groupName : 'microphoenix';
    this.maxLen = options.maxLen ?? 10_000;
    this.maxDeliveries = options.maxDeliveries ?? 5;
    this.minIdleMs = options.minIdleMs ?? 15_000;
    this.pollMs = options.pollMs ?? 50;
    this.claim = options.claim;
    this.redis = new Redis({
      host: options.connection.host ?? '127.0.0.1',
      port: options.connection.port ?? 6379,
      password: options.connection.password,
      db: options.connection.db ?? 0,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.redis.connect();
    this.initialized = true;
  }

  async publish<T extends DomainEvent>(event: T, options: PublishOptions = {}): Promise<void> {
    this.ensureOpen();
    if (options.signal?.aborted) {
      throw new Error(`Publish aborted: ${options.signal.reason ?? 'No reason provided'}`);
    }
    const correlationId = this.correlationOf(event, options.autoGenerateCorrelationId !== false);
    const body: StoredBody = {
      eventId: event.eventId,
      eventType: event.type,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      correlationId,
      causationId: event.causationId,
      timestamp: event.timestamp.toISOString(),
      payload: event.payload ?? {},
      metadata: event.metadata,
    };
    try {
      await this.xadd(this.streamKey(event.type), body);
      this.metrics.eventsPublished += 1;
    } catch (error) {
      this.metrics.eventsFailed += 1;
      throw EventBusError.publishFailed(event.type, error as Error);
    }
  }

  async publishBatch<T extends DomainEvent>(events: T[], options: PublishOptions = {}): Promise<void> {
    for (const event of events) {
      await this.publish(event, options);
    }
  }

  async subscribe(eventType: string, handler: EventHandler, options?: SubscriptionOptions): Promise<string> {
    this.ensureOpen();
    if (!EventBusUtils.isValidEventType(eventType)) {
      throw EventBusError.subscribeFailed(eventType, new Error('invalid event type'));
    }
    await this.ensureGroup(this.streamKey(eventType));
    const subscriptionId = EventBusUtils.generateSubscriptionId();
    const info: SubscriberInfo = {
      subscriberId: subscriptionId,
      eventType,
      handler,
      options: options ?? {},
      registeredAt: new Date(),
      processedCount: 0,
      errorCount: 0,
    };
    this.subscriptions.set(subscriptionId, info);
    const group = this.handlers.get(eventType) ?? new Map<string, EventHandler>();
    group.set(subscriptionId, handler);
    this.handlers.set(eventType, group);
    this.metrics.subscriberCount = this.subscriptions.size;
    this.metrics.channelCount = this.handlers.size;
    this.ensureLoop();
    return subscriptionId;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const info = this.subscriptions.get(subscriptionId);
    if (!info) return;
    this.subscriptions.delete(subscriptionId);
    const group = this.handlers.get(info.eventType);
    group?.delete(subscriptionId);
    if (group && group.size === 0) this.handlers.delete(info.eventType);
    this.metrics.subscriberCount = this.subscriptions.size;
    this.metrics.channelCount = this.handlers.size;
  }

  async unsubscribeAll(eventType: string): Promise<void> {
    const group = this.handlers.get(eventType);
    if (!group) return;
    for (const subscriptionId of group.keys()) this.subscriptions.delete(subscriptionId);
    this.handlers.delete(eventType);
    this.metrics.subscriberCount = this.subscriptions.size;
    this.metrics.channelCount = this.handlers.size;
  }

  async isSubscribed(subscriptionId: string): Promise<boolean> {
    return this.subscriptions.has(subscriptionId);
  }

  async getSubscriberCount(eventType: string): Promise<number> {
    return this.handlers.get(eventType)?.size ?? 0;
  }

  async getSubscriberInfo(subscriptionId: string): Promise<SubscriberInfo | null> {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  async getAllSubscriptions(): Promise<SubscriberInfo[]> {
    return [...this.subscriptions.values()];
  }

  async getMetrics(): Promise<EventBusMetrics> {
    return { ...this.metrics, uptime: Date.now() - this.startedAt };
  }

  async isHealthy(): Promise<boolean> {
    if (!this.initialized || this.closed) return false;
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async getDeadLetterQueue(eventType?: string, limit = 50): Promise<DeadLetterEvent[]> {
    this.ensureOpen();
    const types = eventType ? [eventType] : [...this.dlqTypes];
    const events: DeadLetterEvent[] = [];
    for (const type of types) {
      const raw = await this.redis.xrange(this.dlqKey(type), '-', '+', 'COUNT', limit);
      for (const row of raw) {
        const fields = pairsToFields(row[1]);
        const body = JSON.parse(fields.body) as StoredBody;
        events.push(toDeadLetter(body));
        if (events.length >= limit) return events;
      }
    }
    return events;
  }

  async replayDeadLetterEvent(deadLetterEvent: DeadLetterEvent): Promise<void> {
    await this.publish(deadLetterEvent.originalEvent);
  }

  async clearDeadLetterQueue(eventType?: string): Promise<void> {
    this.ensureOpen();
    const types = eventType ? [eventType] : [...this.dlqTypes];
    for (const type of types) {
      await this.redis.del(this.dlqKey(type));
      this.dlqTypes.delete(type);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.stop = true;
    this.closed = true;
    if (this.loop) await this.loop;
    await this.claim?.close();
    if (this.redis.status !== 'end') {
      try { await this.redis.quit(); } catch { this.redis.disconnect(); }
    }
  }

  private correlationOf(event: DomainEvent, generate: boolean): string {
    if (typeof event.correlationId === 'string' && CorrelationIdProvider.isValid(event.correlationId)) {
      return CorrelationIdProvider.normalize(event.correlationId);
    }
    if (generate) return CorrelationIdProvider.generate();
    throw EventBusError.publishFailed(event.type, new Error('Invalid correlationId'));
  }

  private streamKey(eventType: string): string {
    return `${this.prefix}stream:${eventType}`;
  }

  private dlqKey(eventType: string): string {
    return `${this.prefix}dlq:${eventType}`;
  }

  private ensureOpen(): void {
    if (!this.initialized) throw new Error('Event Bus is not initialized. Call initialize() first.');
    if (this.closed) throw new Error('Event Bus is closed');
  }

  private ensureLoop(): void {
    if (this.loop) return;
    this.loop = this.runLoop();
  }

  private async runLoop(): Promise<void> {
    while (!this.stop) {
      let delivered = 0;
      for (const eventType of [...this.handlers.keys()]) {
        if (this.stop) return;
        delivered += await this.pump(eventType);
      }
      if (!this.stop && delivered === 0) await sleep(this.pollMs);
    }
  }

  private async pump(eventType: string): Promise<number> {
    const stream = this.streamKey(eventType);
    try {
      const pending = await this.autoClaim(stream);
      const fresh = await this.readNew(stream);
      const entries = [...pending, ...fresh];
      for (const entry of entries) {
        if (this.stop) return entries.length;
        await this.deliver(eventType, entry);
      }
      return entries.length;
    } catch (error) {
      if (this.stop) return 0;
      console.error('Redis Streams pump failed:', error);
      await sleep(this.pollMs);
      return 0;
    }
  }

  private async deliver(eventType: string, entry: StreamEntry): Promise<void> {
    const body = JSON.parse(entry.fields.body) as StoredBody;
    const event = toDomainEvent(body);
    const handlers = [...(this.handlers.get(eventType)?.entries() ?? [])];
    if (handlers.length === 0) return;
    if (this.claim && await this.claim.alreadyFinished(this.groupName, event.eventId)) {
      await this.ack(this.streamKey(eventType), entry.id);
      return;
    }
    try {
      for (const [subscriptionId, handler] of handlers) {
        await handler(event);
        const info = this.subscriptions.get(subscriptionId);
        if (info) info.processedCount += 1;
      }
      if (this.claim) await this.claim.finish(this.groupName, event.eventId);
      await this.ack(this.streamKey(eventType), entry.id);
      this.attempts.delete(entry.id);
    } catch (error) {
      for (const [subscriptionId] of handlers) {
        const info = this.subscriptions.get(subscriptionId);
        if (info) info.errorCount += 1;
      }
      const seen = (this.attempts.get(entry.id) ?? 0) + 1;
      this.attempts.set(entry.id, seen);
      if (seen >= this.maxDeliveries) {
        await this.xadd(this.dlqKey(eventType), {
          ...body,
          error: { message: error instanceof Error ? error.message : String(error) },
          retryCount: seen,
        });
        this.dlqTypes.add(eventType);
        await this.ack(this.streamKey(eventType), entry.id);
        this.attempts.delete(entry.id);
      }
    }
  }

  private async ensureGroup(stream: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, this.groupName, '0', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  private async xadd(stream: string, body: StoredBody): Promise<void> {
    await this.redis.xadd(stream, 'MAXLEN', '~', this.maxLen, '*', 'body', JSON.stringify(body));
  }

  private async ack(stream: string, id: string): Promise<void> {
    await this.redis.xack(stream, this.groupName, id);
  }

  private async readNew(stream: string): Promise<StreamEntry[]> {
    const raw = await this.redis.xreadgroup(
      'GROUP', this.groupName, this.consumerName,
      'COUNT', 20,
      'STREAMS', stream, '>',
    );
    return parseReadGroup(raw);
  }

  private async autoClaim(stream: string): Promise<StreamEntry[]> {
    const raw = await this.redis.xautoclaim(
      stream, this.groupName, this.consumerName, this.minIdleMs, '0-0', 'COUNT', 20,
    );
    return parseAutoClaim(raw);
  }
}

function toDomainEvent(body: StoredBody): DomainEvent {
  return {
    eventId: body.eventId,
    type: body.eventType,
    eventType: body.eventType,
    aggregateId: body.aggregateId,
    aggregateVersion: body.aggregateVersion,
    correlationId: body.correlationId,
    causationId: body.causationId,
    timestamp: new Date(body.timestamp),
    payload: body.payload,
    metadata: body.metadata,
  };
}

function toDeadLetter(body: StoredBody): DeadLetterEvent {
  return {
    originalEvent: toDomainEvent(body),
    error: { message: body.error?.message ?? 'delivery failed' },
    deadLetterAt: new Date(),
    retryCount: body.retryCount ?? 0,
  };
}

function pairsToFields(pairs: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i += 2) fields[pairs[i]] = pairs[i + 1];
  return fields;
}

function parseReadGroup(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: StreamEntry[] = [];
  for (const stream of raw as Array<[string, Array<[string, string[]]>]>) {
    for (const [id, pairs] of stream[1] ?? []) {
      entries.push({ id, fields: pairsToFields(pairs) });
    }
  }
  return entries;
}

function parseAutoClaim(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw) || !Array.isArray(raw[1])) return [];
  const entries: StreamEntry[] = [];
  for (const row of raw[1] as Array<[string, string[]]>) {
    entries.push({ id: row[0], fields: pairsToFields(row[1]) });
  }
  return entries;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
