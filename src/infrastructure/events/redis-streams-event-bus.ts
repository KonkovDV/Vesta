/**
 * Redis Streams event bus.
 * XADD keeps the entry when no consumer is running. A handler that does not
 * acknowledge leaves the entry pending, and the next consumer claims it.
 *
 * What the server supports decides two XADD options (see streamFeaturesFor):
 * - Redis 8.2 `ACKED`: trimming to MAXLEN keeps an entry a consumer group has not
 *   acknowledged. Older servers trim it, so a group that falls more than MAXLEN
 *   entries behind loses the oldest ones.
 * - Redis 8.6 `IDMP <producer> <eventId>`: a second XADD of one event, such as an
 *   outbox retry after a crash between XADD and the published mark, returns the first
 *   entry instead of adding another. Redis keeps the last 100 ids for 100 s per stream
 *   by default; outside that window processed_events still skips the repeat.
 *
 * With `ACKED`, a group that stops reading keeps every entry it has not acknowledged,
 * so its stream grows. Every `hardCapCheckEvery` publishes to a stream the bus reads
 * XLEN; above `hardMaxLen` (default 10 x MAXLEN) it runs `XTRIM MAXLEN ~ hardMaxLen
 * DELREF`, counts the dropped entries in `event_bus_stream_forced_trim_entries_total`,
 * and logs an error. `~` keeps one call under the Redis work limit (100 stream nodes),
 * so a large backlog is cut over several checks. The journal still holds those events.
 * A server that does not allow INFO gets neither option.
 *
 * Retries count deliveries in the pending entries list, not in process memory, so a
 * handler that kills the process still reaches the dead-letter stream after
 * `maxDeliveries`. An entry the bus cannot parse goes there on its first delivery.
 */
import Redis from 'ioredis';
import type { ConnectionOptions } from 'node:tls';
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
import { getOrCreateCounter } from '../../monitoring';

const FORCED_TRIM_ENTRIES = getOrCreateCounter(
  'event_bus_stream_forced_trim_entries_total',
  'Stream entries dropped by the hard cap because a consumer group fell too far behind',
  ['stream'],
);

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
    /** `REDIS_TLS=true`: without it the client talks plain TCP to a TLS port. */
    tls?: ConnectionOptions;
  };
  keyPrefix?: string;
  groupName?: string;
  maxLen?: number;
  maxDeliveries?: number;
  /** Pending entries idle at least this long are claimed. 0 claims immediately. */
  minIdleMs?: number;
  /** Sleep after a read that found nothing. Default 50 ms. */
  pollMs?: number;
  /**
   * Each empty read doubles the sleep up to this. A delivery, a subscribe or a publish
   * from this process resets it. Default 1000 ms.
   */
  maxPollMs?: number;
  claim?: ProcessedEventClaim;
  /** Longest a stream may grow when ACKED keeps unacknowledged entries. Default 10 x maxLen. */
  hardMaxLen?: number;
  /** Publishes to one stream between two XLEN checks of the hard cap. Default 100. */
  hardCapCheckEvery?: number;
}

/** Stream options of the connected server. */
export interface StreamFeatures {
  /** XADD ... ACKED (Redis 8.2): trimming keeps entries a consumer group has not acknowledged. */
  ackedTrim: boolean;
  /** XADD ... IDMP pid iid (Redis 8.6): a repeated add of one id returns the first entry. */
  idempotentAdd: boolean;
}

/**
 * Reads `redis_version` from INFO. Forks that report an older Redis version
 * (Valkey reports 7.2.x) get neither option, which is the behaviour before 8.2.
 */
export function streamFeaturesFor(redisVersion: string | undefined): StreamFeatures {
  const match = /^(\d+)\.(\d+)/.exec((redisVersion ?? '').trim());
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  const atLeast = (wantMajor: number, wantMinor: number) =>
    major > wantMajor || (major === wantMajor && minor >= wantMinor);
  return { ackedTrim: atLeast(8, 2), idempotentAdd: atLeast(8, 6) };
}

/** XADD arguments after the key, in the order Redis requires. */
export function xaddArguments(
  features: StreamFeatures,
  maxLen: number,
  body: string,
  idempotency?: { producer: string; id: string },
): Array<string | number> {
  return [
    ...(features.ackedTrim ? ['ACKED'] : []),
    ...(features.idempotentAdd && idempotency ? ['IDMP', idempotency.producer, idempotency.id] : []),
    'MAXLEN', '~', maxLen,
    '*', 'body', body,
  ];
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
  private readonly hardMaxLen: number;
  private readonly hardCapCheckEvery: number;
  private readonly publishesSinceCheck = new Map<string, number>();
  private forcedTrims = 0;
  private readonly pollMs: number;
  private readonly maxPollMs: number;
  /** Ends the loop's current sleep. */
  private wake: (() => void) | null = null;
  private readonly claim?: ProcessedEventClaim;
  private readonly consumerName = `c-${IdGenerator.generateWithPrefix('stream')}`;
  private readonly subscriptions = new Map<string, SubscriberInfo>();
  private readonly handlers = new Map<string, Map<string, EventHandler>>();
  /** Every event type this bus has read, to remove its consumer from those groups on close. */
  private readonly readTypes = new Set<string>();
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
  private features: StreamFeatures = { ackedTrim: false, idempotentAdd: false };
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
    this.hardMaxLen = Math.max(this.maxLen, options.hardMaxLen ?? this.maxLen * 10);
    this.hardCapCheckEvery = Math.max(1, options.hardCapCheckEvery ?? 100);
    this.pollMs = Math.max(1, options.pollMs ?? 50);
    this.maxPollMs = Math.max(this.pollMs, options.maxPollMs ?? 1_000);
    this.claim = options.claim;
    this.redis = new Redis({
      host: options.connection.host ?? '127.0.0.1',
      port: options.connection.port ?? 6379,
      password: options.connection.password,
      db: options.connection.db ?? 0,
      ...(options.connection.tls ? { tls: options.connection.tls } : {}),
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.redis.connect();
    try {
      const info = await this.redis.info('server');
      this.features = streamFeaturesFor(/redis_version:([^\r\n]+)/.exec(info)?.[1]);
    } catch (error) {
      // A managed Redis or an ACL may refuse or rename INFO. The bus then uses the XADD
      // every version accepts. Any other failure, such as a dropped connection, stops the
      // start: silently losing ACKED for the life of the process would be worse.
      const message = error instanceof Error ? error.message : String(error);
      if (!/NOPERM|unknown command/i.test(message)) throw error;
      this.features = { ackedTrim: false, idempotentAdd: false };
      console.warn('[RedisStreamsEventBus] INFO is not allowed; adding entries without ACKED and IDMP:', message);
    }
    this.initialized = true;
  }

  /** Trims by the hard cap that dropped entries, since this bus started. */
  getForcedTrimCount(): number {
    return this.forcedTrims;
  }

  /** The XADD options this bus uses on the connected server. */
  getStreamFeatures(): StreamFeatures {
    return { ...this.features };
  }

  async publish<T extends DomainEvent>(event: T, options: PublishOptions = {}): Promise<void> {
    await this.append(event, options, true);
  }

  /** `idempotent` is false for a dead-letter replay: that one must add a new entry. */
  private async append<T extends DomainEvent>(event: T, options: PublishOptions, idempotent: boolean): Promise<void> {
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
    const stream = this.streamKey(event.type);
    try {
      await this.xadd(stream, body, idempotent ? event.eventId : undefined);
      this.metrics.eventsPublished += 1;
    } catch (error) {
      this.metrics.eventsFailed += 1;
      throw EventBusError.publishFailed(event.type, error as Error);
    }
    if (this.handlers.has(event.type)) this.wake?.();
    // After the entry is in the stream: a failed check must not fail the publish, or the outbox adds it again.
    if (this.features.ackedTrim) await this.enforceHardCap(stream);
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
    this.readTypes.add(eventType);
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
    this.wake?.();
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
        const entry = { id: row[0], fields: pairsToFields(row[1]) };
        events.push(toDeadLetter(parseStoredBody(entry.fields.body) ?? unreadableBody(type, entry, 'unreadable dead-letter entry')));
        if (events.length >= limit) return events;
      }
    }
    return events;
  }

  async replayDeadLetterEvent(deadLetterEvent: DeadLetterEvent): Promise<void> {
    await this.append(deadLetterEvent.originalEvent, {}, false);
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
    this.wake?.();
    if (this.loop) await this.loop;
    await this.releaseConsumer();
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

  /**
   * Two commands per subscribed stream per round. A fixed 50 ms sleep made that about
   * 38 commands a second per stream on an idle bus; the doubling sleep brings it to 2.
   */
  private async runLoop(): Promise<void> {
    let idle = this.pollMs;
    while (!this.stop) {
      let delivered = 0;
      for (const eventType of [...this.handlers.keys()]) {
        if (this.stop) return;
        delivered += await this.pump(eventType);
      }
      if (this.stop) return;
      if (delivered > 0) {
        idle = this.pollMs;
        continue;
      }
      if (await this.sleepUnlessWoken(idle)) idle = this.pollMs;
      else idle = Math.min(idle * 2, this.maxPollMs);
    }
  }

  /** True when a publish, a subscribe or close() ended the sleep early. */
  private sleepUnlessWoken(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve(false);
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve(true);
      };
    });
  }

  private async pump(eventType: string): Promise<number> {
    const stream = this.streamKey(eventType);
    try {
      const pending = await this.autoClaim(stream);
      const deliveries = await this.deliveryCounts(stream, pending);
      const fresh = await this.readNew(stream);
      const entries = [...pending, ...fresh];
      for (const entry of entries) {
        if (this.stop) return entries.length;
        await this.deliver(eventType, entry, deliveries.get(entry.id) ?? 1);
      }
      return entries.length;
    } catch (error) {
      if (this.stop) return 0;
      console.error('Redis Streams pump failed:', error);
      await sleep(this.pollMs);
      return 0;
    }
  }

  /**
   * `deliveries` is this delivery's number in the pending entries list: 1 for a new entry,
   * more for a claimed one. It survives a restart, unlike a counter in memory.
   */
  private async deliver(eventType: string, entry: StreamEntry, deliveries: number): Promise<void> {
    const handlers = [...(this.handlers.get(eventType)?.entries() ?? [])];
    if (handlers.length === 0) return;
    const body = parseStoredBody(entry.fields.body);
    if (!body) {
      // No retry can parse it, and left pending it would stop every entry behind it.
      await this.deadLetter(eventType, entry.id, unreadableBody(eventType, entry, 'unreadable stream entry'), deliveries);
      return;
    }
    const event = toDomainEvent(body);
    if (this.claim && await this.claim.alreadyFinished(this.groupName, event.eventId)) {
      await this.ack(this.streamKey(eventType), entry.id);
      return;
    }
    if (deliveries > this.maxDeliveries) {
      // Claimed again after maxDeliveries attempts without an acknowledgement: the handler
      // stopped the process or outran the claim time. Running it again may do the same.
      await this.deadLetter(eventType, entry.id, {
        ...body,
        error: { message: `delivered ${deliveries} times without an acknowledgement` },
      }, deliveries);
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
    } catch (error) {
      for (const [subscriptionId] of handlers) {
        const info = this.subscriptions.get(subscriptionId);
        if (info) info.errorCount += 1;
      }
      if (deliveries >= this.maxDeliveries) {
        await this.deadLetter(eventType, entry.id, {
          ...body,
          error: { message: error instanceof Error ? error.message : String(error) },
        }, deliveries);
      }
    }
  }

  private async deadLetter(eventType: string, entryId: string, body: StoredBody, deliveries: number): Promise<void> {
    await this.xadd(this.dlqKey(eventType), { ...body, retryCount: deliveries });
    this.dlqTypes.add(eventType);
    await this.ack(this.streamKey(eventType), entryId);
  }

  /** Delivery numbers of claimed entries, read from the pending entries list in one round trip. */
  private async deliveryCounts(stream: string, claimed: StreamEntry[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (claimed.length === 0) return counts;
    const pipeline = this.redis.pipeline();
    for (const entry of claimed) pipeline.xpending(stream, this.groupName, entry.id, entry.id, 1);
    const replies = (await pipeline.exec()) ?? [];
    replies.forEach(([error, reply], index) => {
      // [[id, consumer, idle ms, deliveries]]; an entry another consumer took meanwhile is missing.
      const row = !error && Array.isArray(reply) ? (reply[0] as unknown[] | undefined) : undefined;
      const count = Number(row?.[3]);
      if (Number.isSafeInteger(count) && count > 0) counts.set(claimed[index].id, count);
    });
    return counts;
  }

  /**
   * A process that restarts reads under a new consumer name; without this, every stop
   * leaves an empty consumer in each group. A consumer that still holds pending entries
   * is kept: deleting it would make them unclaimable.
   */
  private async releaseConsumer(): Promise<void> {
    if (!this.initialized || this.redis.status !== 'ready') return;
    for (const eventType of this.readTypes) {
      const stream = this.streamKey(eventType);
      try {
        const held = await this.redis.xpending(stream, this.groupName, '-', '+', 1, this.consumerName);
        if (Array.isArray(held) && held.length === 0) {
          await this.redis.xgroup('DELCONSUMER', stream, this.groupName, this.consumerName);
        }
      } catch {
        // Shutdown goes on; the consumer stays listed in XINFO CONSUMERS.
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

  /** ACKED never drops an unacknowledged entry; this bound keeps a stopped group from filling Redis. */
  private async enforceHardCap(stream: string): Promise<void> {
    const seen = (this.publishesSinceCheck.get(stream) ?? 0) + 1;
    if (seen < this.hardCapCheckEvery) {
      this.publishesSinceCheck.set(stream, seen);
      return;
    }
    this.publishesSinceCheck.set(stream, 0);
    let length: number;
    let dropped: number;
    try {
      length = await this.redis.xlen(stream);
      if (length <= this.hardMaxLen) return;
      // `~` caps the work of one call (Redis LIMIT, 100 stream nodes); DELREF also drops the entries' PEL references.
      dropped = Number(await this.redis.call('XTRIM', stream, 'MAXLEN', '~', this.hardMaxLen, 'DELREF'));
    } catch (error) {
      console.warn(
        `[RedisStreamsEventBus] hard cap check on ${stream} failed; the next check comes after ${this.hardCapCheckEvery} publishes:`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (!(dropped > 0)) return;
    this.forcedTrims += 1;
    try {
      FORCED_TRIM_ENTRIES.labels({ stream }).inc(dropped);
    } catch {
      // Metrics must never stop a publish.
    }
    console.error(
      `[RedisStreamsEventBus] ${stream} held ${length} entries, over the hard cap ${this.hardMaxLen}: ` +
      `dropped the ${dropped} oldest, including entries a consumer group had not acknowledged. ` +
      'Check XINFO GROUPS for a group that stopped reading; the journal still holds these events.',
    );
  }

  private async xadd(stream: string, body: StoredBody, idempotentId?: string): Promise<void> {
    const idempotency = idempotentId ? { producer: `${this.prefix}events`, id: idempotentId } : undefined;
    await this.redis.call('XADD', stream, ...xaddArguments(this.features, this.maxLen, JSON.stringify(body), idempotency));
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

/** The body this bus wrote, or null for anything else: bad JSON, no body field, no event id. */
export function parseStoredBody(raw: string | undefined): StoredBody | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = parsed as Partial<StoredBody>;
  if (typeof body.eventId !== 'string' || body.eventId.length === 0) return null;
  if (typeof body.eventType !== 'string' || typeof body.timestamp !== 'string') return null;
  return body as StoredBody;
}

/** A dead-letter body for an entry the bus cannot read; the raw fields go into the payload. */
function unreadableBody(eventType: string, entry: StreamEntry, message: string): StoredBody {
  return {
    eventId: `stream-entry:${entry.id}`,
    eventType,
    aggregateId: '',
    aggregateVersion: 0,
    correlationId: '',
    timestamp: new Date().toISOString(),
    payload: { streamEntryId: entry.id, fields: entry.fields },
    error: { message },
  };
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
