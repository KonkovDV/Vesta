/**
 * Redis Event Bus - реализация через Redis Pub/Sub
 * Layer: Infrastructure (техническая реализация)
 *
 * Реализует IEventBus с использованием ioredis. Исправлено:
 * - Убран несуществующий PubSub из ioredis, вместо него используется второй клиент подписчика
 * - Корректно реализованы subscribe, unsubscribe и обработка сообщений
 * - Убрана нерабочая ветка persistEvents в publish (отсутствует this.eventStore)
 */

import Redis, { Redis as RedisClient } from 'ioredis';
import { DomainEvent } from '../../domain/events/event-store.interface';
import {
  IEventBus,
  EventHandler,
  PublishOptions,
  SubscriptionOptions,
  EventBusMetrics,
  SubscriberInfo,
  DeadLetterEvent,
  EventBusError,
  EventBusUtils,
  EventHandlerFactory,
  EventProcessingContext
} from '../../domain/events/event-bus.interface';
import { getRedisEventBusConfig } from '../config/config';
import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';
import { getMetricsConfig } from '../../core/config/app-config';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { IdGenerator } from '../../core/utils/IdGenerator';
import { getConfig } from '../../config';
import { safeJsonParse, tryJsonParse } from '../../core/utils/json';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

 // Prometheus metrics for Event Bus (global register); guarded centrally via getMetricsConfig().enabled and not in tests
 const { JEST_WORKER_ID, NODE_ENV, REDIS_EVENT_BUS_LOGS } = getConfig();
 const IS_TEST_ENV = Boolean(JEST_WORKER_ID || NODE_ENV === 'test');
 const { enabled, eventLatencyBucketsMs } = getMetricsConfig();
 const EB_METRICS_ON = enabled && !IS_TEST_ENV;


const EB_PUBLISHED_TOTAL = getOrCreateCounter(
  'event_bus_published_total',
  'Events published to event bus',
  ['event_type']
);
const EB_FAILED_TOTAL = getOrCreateCounter(
  'event_bus_failed_total',
  'Events failed to publish to event bus',
  ['event_type']
);
const EB_DISPATCH_LATENCY_MS = getOrCreateHistogram(
  'event_bus_dispatch_latency_ms',
  'Event dispatch latency (ms) to subscribers',
  ['event_type'],
  eventLatencyBucketsMs
);

/**
 * Конфигурация Redis Event Bus
 */
export interface RedisEventBusConfig {
  /** Настройки подключения к Redis */
  connection: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    retryDelayOnFailover?: number;
    enableOfflineQueue?: boolean;
    lazyConnect?: boolean;
    maxRetriesPerRequest?: number;
    [key: string]: unknown;
  };
  /** Префикс для всех ключей Redis */
  keyPrefix?: string;
  /** Размер подписки для batch публикации */
  batchSize?: number;
  /** Интервал между batch публикациями (мс) */
  batchInterval?: number;
  /** Таймаут обработки по умолчанию (мс) */
  defaultTimeoutMs?: number;
  /** Максимальное количество попыток по умолчанию */
  defaultMaxRetries?: number;
  /** Интервал между попытками (мс) */
  retryDelayMs?: number;
  /** Включить Dead Letter Queue */
  enableDeadLetterQueue?: boolean;
  /** Максимальный размер Dead Letter Queue */
  deadLetterQueueMaxSize?: number;
  /** Включить метрики */
  enableMetrics?: boolean;
  /** Интервал сбора метрик (мс) */
  metricsInterval?: number;
}

/**
 * Структура сообщения для Redis
 */
interface RedisEventMessage {
  eventId: string;
  eventType: string;
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  publisherId: string;
  publishOptions?: PublishOptions;
}

/**
 * Redis Event Bus реализация
 */
export class RedisEventBus implements IEventBus {
  private readonly redis: RedisClient;       // издатель
  private readonly subscriber: RedisClient;  // подписчик
  private readonly config: Required<RedisEventBusConfig>;

  // Подписки
  private subscriptions = new Map<string, SubscriberInfo>();           // subscriptionId -> info
  private eventSubscribers = new Map<string, Set<string>>();           // eventType -> Set<subscriptionId>

  // Метрики
  private metrics: EventBusMetrics = {
    eventsPublished: 0,
    eventsFailed: 0,
    averageProcessingTime: 0,
    subscriberCount: 0,
    channelCount: 0,
    uptime: 0
  };

  // Состояние
  private isInitialized = false;
  /** One in-flight initialize() so overlapping callers share a single Redis connect. */
  private initialization: Promise<void> | null = null;
  private isClosed = false;
  private startTime = Date.now();

  // Batch публикация
  private publishQueue: Array<{ event: DomainEvent; options?: PublishOptions }> = [];
  private batchTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;

  // Стабильные обработчики событий Redis-клиентов (publisher/subscriber)
  private readonly onPublisherError = (error: Error): void => {
     
    console.error('Redis Event Bus publisher error:', error);
  };

  private readonly onPublisherConnect = (): void => {
    this.debug('📡 Redis Event Bus publisher connected');
  };

  private readonly onPublisherDisconnect = (): void => {
    this.debug('📡 Redis Event Bus publisher disconnected');
  };

  private readonly onSubscriberError = (error: Error): void => {
     
    console.error('Redis Event Bus subscriber error:', error);
  };

  private readonly onSubscriberConnect = (): void => {
    this.debug('📡 Redis Event Bus subscriber connected');
  };

  private readonly onSubscriberDisconnect = (): void => {
    this.debug('📡 Redis Event Bus subscriber disconnected');
  };

  private readonly onSubscriberMessage = (channel: string, message: string): void => {
    this.dispatchMessage(channel, message).catch((err) => {
       
      console.error('Redis Event Bus dispatch error:', err);
    });
  };

  // Тихий логгер для тестовой среды: полностью глушит информационные логи,
  // чтобы не нарушать Jest teardown и не получать "Cannot log after tests are done".
  private readonly debugEnabled: boolean =
    !(Boolean(JEST_WORKER_ID || NODE_ENV === 'test') || REDIS_EVENT_BUS_LOGS === 'false');

  private debug(...args: unknown[]): void {
    if (!this.debugEnabled) return;
     
    console.log(...args);
  }

  private readonly logger?: IStructuredLogger;

  constructor(config: RedisEventBusConfig, logger?: IStructuredLogger) {
    this.logger = logger;
    this.config = {
      keyPrefix: config.keyPrefix || 'microphoenix:eventbus:',
      batchSize: config.batchSize || 100,
      batchInterval: config.batchInterval || 100,
      defaultTimeoutMs: config.defaultTimeoutMs || 5000,
      defaultMaxRetries: config.defaultMaxRetries || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      enableDeadLetterQueue: config.enableDeadLetterQueue ?? true,
      deadLetterQueueMaxSize: config.deadLetterQueueMaxSize || 1000,
      enableMetrics: config.enableMetrics ?? true,
      metricsInterval: config.metricsInterval || 60000,
      ...config
    };

    // Клиент издателя
    this.redis = new Redis({
      host: this.config.connection.host || 'localhost',
      port: this.config.connection.port || 6379,
      password: this.config.connection.password,
      db: this.config.connection.db || 0,
      retryDelayOnFailover: this.config.connection.retryDelayOnFailover || 100,
      enableOfflineQueue: this.config.connection.enableOfflineQueue ?? true,
      lazyConnect: this.config.connection.lazyConnect ?? true,
      maxRetriesPerRequest: this.config.connection.maxRetriesPerRequest || 3,
      ...this.config.connection
    });

    // Клиент подписчика
    this.subscriber = new Redis({
      host: this.config.connection.host || 'localhost',
      port: this.config.connection.port || 6379,
      password: this.config.connection.password,
      db: this.config.connection.db || 0,
      retryDelayOnFailover: this.config.connection.retryDelayOnFailover || 100,
      enableOfflineQueue: this.config.connection.enableOfflineQueue ?? true,
      lazyConnect: this.config.connection.lazyConnect ?? true,
      maxRetriesPerRequest: this.config.connection.maxRetriesPerRequest || 3,
      ...this.config.connection
    });

    this.setupEventHandlers();
  }

  /**
   * Инициализация Event Bus с оптимизациями для тестов
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (!this.initialization) {
      this.initialization = this.initializeOnce().finally(() => {
        this.initialization = null;
      });
    }
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Проверка подключения к Redis
      await this.redis.ping();
      await this.subscriber.ping();

      // Подписчик слушает входящие сообщения (обработчик навешивается в setupEventHandlers)

      this.debug('✅ Redis Event Bus initialized successfully');

      this.isInitialized = true;

      // Метрики включаем только вне тестовой среды и при явном разрешении
      const config = getConfig();
      const isTestEnv = Boolean(config.JEST_WORKER_ID || config.NODE_ENV === 'test');
      const metricsExplicitlyDisabled = config.REDIS_EVENT_BUS_METRICS === 'false';
      if (!isTestEnv && this.config.enableMetrics && !metricsExplicitlyDisabled) {
        this.startMetricsCollection();
      }

      // Запуск batch обработки
      this.startBatchPublishing();

    } catch (error) {
      console.error('❌ Failed to initialize Redis Event Bus:', error);
      throw EventBusError.publishFailed('init', error as Error);
    }
  }

  /**
   * Опубликовать событие
   */
  async publish<T extends DomainEvent>(event: T, options: PublishOptions = {}): Promise<void> {
    this.ensureInitialized();

    const {
      autoGenerateCorrelationId = true,
      // persistEvents = false,  // НЕРЕАЛИЗОВАНО: сохранять события должен Event Store/Outbox
      timeoutMs = this.config.defaultTimeoutMs,
      priority = 'NORMAL',
      metadata = {}
    } = options;

    // Валидация/нормализация correlation_id
    let corr: string;
    if (typeof event.correlationId === 'string' && CorrelationIdProvider.isValid(event.correlationId)) {
      corr = CorrelationIdProvider.normalize(event.correlationId);
    } else if (autoGenerateCorrelationId) {
      corr = CorrelationIdProvider.generate();
    } else {
      throw EventBusError.publishFailed(event.type, new Error('Invalid correlationId'));
    }

    const processedEvent: T = {
      ...event,
      correlationId: corr
    };

    // Создание Redis сообщения
    const mergedMetadata = { ...processedEvent.metadata, ...metadata };
    const redisMessage: RedisEventMessage = {
      eventId: processedEvent.eventId,
      eventType: processedEvent.type,
      aggregateId: processedEvent.aggregateId,
      aggregateVersion: processedEvent.aggregateVersion,
      correlationId: processedEvent.correlationId,
      causationId: processedEvent.causationId,
      traceId: typeof mergedMetadata.traceId === 'string' ? mergedMetadata.traceId : undefined,
      spanId: typeof mergedMetadata.spanId === 'string' ? mergedMetadata.spanId : undefined,
      parentSpanId: typeof mergedMetadata.parentSpanId === 'string' ? mergedMetadata.parentSpanId : undefined,
      timestamp: processedEvent.timestamp.toISOString(),
      payload: (processedEvent.payload ?? {}),
      metadata: mergedMetadata,
      publisherId: IdGenerator.generateWithPrefix('publisher'),
      publishOptions: options
    };

    // Публикация в Redis
    const channel = EventBusUtils.createChannelKey(processedEvent.type);
    const messageStr = JSON.stringify(redisMessage);

    // Deep Preemption: Check abort signal before network call (ADR-013)
    const { signal } = options;
    if (signal?.aborted) {
      throw new Error(`Publish aborted: ${signal.reason ?? 'No reason provided'}`);
    }

    try {
      // Wrap Redis publish with abort signal support
      const publishPromise = this.redis.publish(channel, messageStr);
      
      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error(`Publish aborted: ${signal.reason ?? 'Operation cancelled'}`));
          }, { once: true });
        });
        await Promise.race([publishPromise, abortPromise]);
      } else {
        await publishPromise;
      }
      this.metrics.eventsPublished++;
      this.updateUptime();

      if (EB_METRICS_ON) {
        EB_PUBLISHED_TOTAL.labels(processedEvent.type).inc();
      }

      if (getConfig().EVENT_BUS_LOGS === 'json') {
        try {
          // structured JSON log
           
          console.info(JSON.stringify({
            msg: 'event_published',
            channel,
            event_type: processedEvent.type,
            event_id: processedEvent.eventId,
            correlation_id: processedEvent.correlationId,
            aggregate_id: processedEvent.aggregateId,
            ts: new Date().toISOString()
          }));
        } catch {
          // ignore logging failures
        }
      }
 
      this.debug(`📢 Published event ${processedEvent.type}:${processedEvent.eventId} to ${channel}`);
    } catch (error) {
      this.metrics.eventsFailed++;
      if (EB_METRICS_ON) {
        EB_FAILED_TOTAL.labels(processedEvent.type).inc();
      }
      console.error(`❌ Failed to publish event ${processedEvent.type}:`, error);
      throw EventBusError.publishFailed(processedEvent.type, error as Error);
    }
  }

  /**
   * Опубликовать несколько событий
   */
  async publishBatch<T extends DomainEvent>(events: T[], options: PublishOptions = {}): Promise<void> {
    if (events.length === 0) return;

    // Добавляем события в очередь для batch обработки
    for (const event of events) {
      this.publishQueue.push({ event, options });
    }

    // Принудительная публикация если достигнут размер batch
    if (this.publishQueue.length >= this.config.batchSize) {
      await this.processBatch();
    }
  }

  /**
   * Подписаться на события
   */
  async subscribe(
    eventType: string,
    handler: EventHandler,
    options: SubscriptionOptions = {}
  ): Promise<string> {
    this.ensureInitialized();

    if (!EventBusUtils.isValidEventType(eventType)) {
      throw EventBusError.eventTypeNotFound(eventType);
    }

    const subscriptionId = EventBusUtils.generateSubscriptionId();
    const normalizedOptions = {
      priority: EventBusUtils.normalizePriority(options.priority),
      maxRetries: options.maxRetries ?? this.config.defaultMaxRetries,
      timeoutMs: options.timeoutMs ?? this.config.defaultTimeoutMs,
      enableDeadLetterQueue: options.enableDeadLetterQueue ?? this.config.enableDeadLetterQueue,
      ...options
    };

    // Создание обработанного handler (timeout/retry)
    let processedHandler = handler;

    if (normalizedOptions.timeoutMs) {
      processedHandler = EventHandlerFactory.createTimeoutHandler(handler, normalizedOptions.timeoutMs);
    }

    if (normalizedOptions.maxRetries > 0) {
      processedHandler = EventHandlerFactory.createRetryHandler(
        processedHandler,
        normalizedOptions.maxRetries,
        this.config.retryDelayMs
      );
    }

    // Регистрация подписки
    const subscriberInfo: SubscriberInfo = {
      subscriberId: subscriptionId,
      eventType,
      handler: processedHandler,
      options: normalizedOptions,
      registeredAt: new Date(),
      processedCount: 0,
      errorCount: 0
    };

    this.subscriptions.set(subscriptionId, subscriberInfo);

    // Добавление в список подписчиков события
    let set = this.eventSubscribers.get(eventType);
    const wasEmpty = !set || set.size === 0;
    if (!set) {
      set = new Set<string>();
      this.eventSubscribers.set(eventType, set);
    }
    set.add(subscriptionId);

    // Подписка на Redis канал если это первый подписчик данного типа
    if (wasEmpty) {
      try {
        const channel = EventBusUtils.createChannelKey(eventType);
        await this.subscriber.subscribe(channel);
        this.debug(`📝 Subscribed Redis to channel ${channel} for event type ${eventType}`);
      } catch (error) {
        // Откат локальной регистрации
        set.delete(subscriptionId);
        this.subscriptions.delete(subscriptionId);
        console.error(`❌ Failed to subscribe to event type ${eventType}:`, error);
        throw EventBusError.subscribeFailed(eventType, error as Error);
      }
    }

    // Обновление метрик
    this.metrics.subscriberCount = this.subscriptions.size;
    this.metrics.channelCount = this.eventSubscribers.size;

    return subscriptionId;
  }

  /**
   * Отписаться от событий
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const subscriberInfo = this.subscriptions.get(subscriptionId);
    if (!subscriberInfo) {
      throw EventBusError.subscriberNotFound(subscriptionId);
    }

    const eventType = subscriberInfo.eventType;
    this.subscriptions.delete(subscriptionId);

    const set = this.eventSubscribers.get(eventType);
    if (set) {
      set.delete(subscriptionId);
      if (set.size === 0) {
        // Больше нет подписчиков на тип события — отписываем канал
        const channel = EventBusUtils.createChannelKey(eventType);
        await this.subscriber.unsubscribe(channel);
        this.eventSubscribers.delete(eventType);
        this.debug(`🚫 Unsubscribed Redis from channel ${channel}`);
      }
    }

    // Обновление метрик
    this.metrics.subscriberCount = this.subscriptions.size;
    this.metrics.channelCount = this.eventSubscribers.size;
  }

  /**
   * Отписаться от всех событий указанного типа
   */
  async unsubscribeAll(eventType: string): Promise<void> {
    const subscribers = this.eventSubscribers.get(eventType);
    if (!subscribers || subscribers.size === 0) return;

    const ids = Array.from(subscribers);
    for (const id of ids) {
      await this.unsubscribe(id);
    }

    this.debug(`🚫 Unsubscribed all handlers from ${eventType}`);
  }

  /**
   * Проверить статус подписки
   */
  async isSubscribed(subscriptionId: string): Promise<boolean> {
    return this.subscriptions.has(subscriptionId);
  }

  /**
   * Получить количество подписчиков на тип события
   */
  async getSubscriberCount(eventType: string): Promise<number> {
    return this.eventSubscribers.get(eventType)?.size || 0;
  }

  /**
   * Получить информацию о подписчике
   */
  async getSubscriberInfo(subscriptionId: string): Promise<SubscriberInfo | null> {
    return this.subscriptions.get(subscriptionId) || null;
  }

  /**
   * Получить все подписки
   */
  async getAllSubscriptions(): Promise<SubscriberInfo[]> {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Получить метрики Event Bus
   */
  async getMetrics(): Promise<EventBusMetrics> {
    return { ...this.metrics };
  }

  /**
   * Проверить здоровье системы
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.redis.ping();
      await this.subscriber.ping();
      return !this.isClosed;
    } catch (error) {
      console.error('Event Bus health check failed:', error);
      return false;
    }
  }

  /**
   * Получить события из Dead Letter Queue
   */
  async getDeadLetterQueue(eventType?: string, limit?: number): Promise<DeadLetterEvent[]> {
    if (!this.config.enableDeadLetterQueue) {
      return [];
    }

    const max = limit && limit > 0 ? limit : this.config.deadLetterQueueMaxSize;
    const results: DeadLetterEvent[] = [];
    const prefix = this.config.keyPrefix || '';

    const keys: string[] = [];
    if (eventType) {
      keys.push(prefix + EventBusUtils.createDeadLetterQueueKey(eventType));
    } else {
      const pattern = prefix + EventBusUtils.createDeadLetterQueueKey('*');
      const found = await this.redis.keys(pattern);
      keys.push(...found);
    }

    for (const key of keys) {
      const len = await this.redis.llen(key);
      const start = Math.max(0, len - max);
      const items = await this.redis.lrange(key, start, len - 1);
      for (const item of items) {
        const parsed = tryJsonParse<DeadLetterEvent>(item);
        if (!parsed.ok) {
           
          this.logger?.error('Failed to parse dead letter event JSON', {
            key,
            error: parsed.error.message,
          });
          continue;
        }
        results.push(parsed.value);
      }
    }

    return results;
  }

  /**
   * Повторить обработку события из Dead Letter Queue
   */
  async replayDeadLetterEvent(deadLetterEvent: DeadLetterEvent): Promise<void> {
    if (!this.config.enableDeadLetterQueue) {
      throw new Error('Dead Letter Queue is disabled');
    }
    // Пере-публикация оригинального события
    await this.publish(deadLetterEvent.originalEvent);
  }

  /**
   * Очистить Dead Letter Queue
   */
  async clearDeadLetterQueue(eventType?: string): Promise<void> {
    if (!this.config.enableDeadLetterQueue) {
      return;
    }
    const prefix = this.config.keyPrefix || '';
    if (eventType) {
      const key = prefix + EventBusUtils.createDeadLetterQueueKey(eventType);
      await this.redis.del(key);
    } else {
      const pattern = prefix + EventBusUtils.createDeadLetterQueueKey('*');
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    }
  }

  /**
   * Закрыть Event Bus с graceful shutdown
   */
  async close(): Promise<void> {
    if (this.isClosed) return;

    try {
      // Остановка таймеров
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = undefined;
      }
      if (this.metricsTimer) {
        clearInterval(this.metricsTimer);
        this.metricsTimer = undefined;
      }

      // Обработка оставшихся событий в очереди
      if (this.publishQueue.length > 0) {
        await this.processBatch();
      }

      // Отписка от всех каналов (best-effort)
      try {
        const channels = Array.from(this.eventSubscribers.keys()).map(EventBusUtils.createChannelKey);
        if (channels.length > 0) {
          await this.subscriber.unsubscribe(...channels);
        }
      } catch (e) {
        // ignore
      }

      // Очистка всех listeners Redis-клиентов до закрытия соединений
      this.cleanupEventHandlers();

      // Закрытие соединений с таймаутом
      const closeTimeout = 5000; // 5 секунд на закрытие
      const closePromise = Promise.allSettled([
        this.redis.quit(),
        this.subscriber.quit()
      ]).then(() => undefined);

      let timeoutTimer: NodeJS.Timeout | undefined;

      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error('Event Bus close timeout')),
          closeTimeout
        );
      });

      try {
        await Promise.race([closePromise, timeoutPromise]);
      } finally {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
      }

      this.isClosed = true;
      this.subscriptions.clear();
      this.eventSubscribers.clear();

      this.debug('🔒 Redis Event Bus closed successfully');
    } catch (error) {
      this.logger?.error('❌ Error closing Redis Event Bus:', { error: String(error) });
      throw error;
    }
  }

  // ==============================================================================
  // Вспомогательные методы
  // ==============================================================================

  /**
   * Настройка обработчиков событий Redis (ошибки/подключение/сообщения).
   * Использует стабильные bound-хендлеры для корректного снятия listeners.
   */
  private setupEventHandlers(): void {
    if (this.isClosed) {
      return;
    }

    this.redis.on('error', this.onPublisherError);
    this.redis.on('connect', this.onPublisherConnect);
    this.redis.on('disconnect', this.onPublisherDisconnect);

    this.subscriber.on('error', this.onSubscriberError);
    this.subscriber.on('connect', this.onSubscriberConnect);
    this.subscriber.on('disconnect', this.onSubscriberDisconnect);
    this.subscriber.on('message', this.onSubscriberMessage);
  }

  /**
   * Очистка обработчиков событий Redis клиентов.
   * Идемпотентна и безопасна при повторных вызовах.
   */
  private cleanupEventHandlers(): void {
    this.redis.off('error', this.onPublisherError);
    this.redis.off('connect', this.onPublisherConnect);
    this.redis.off('disconnect', this.onPublisherDisconnect);

    this.subscriber.off('error', this.onSubscriberError);
    this.subscriber.off('connect', this.onSubscriberConnect);
    this.subscriber.off('disconnect', this.onSubscriberDisconnect);
    this.subscriber.off('message', this.onSubscriberMessage);
  }

  /**
   * Диспетчер сообщений от Redis подписчика
   */
  private async dispatchMessage(channel: string, message: string): Promise<void> {
    // Извлекаем тип события из ключа канала
    // Domain утилита создает ключ как events:<eventType>
    const prefix = 'events:';
    const eventType = channel.startsWith(prefix) ? channel.substring(prefix.length) : channel;

    const subs = this.eventSubscribers.get(eventType);
    if (!subs || subs.size === 0) {
      return; // Нет подписчиков — игнорируем
    }

    const parsedMessage = tryJsonParse<RedisEventMessage>(message);
    if (!parsedMessage.ok) {
       
      this.logger?.error(`Invalid message JSON for channel ${channel}:`, { error: String(parsedMessage.error) });
      return;
    }
    const redisMessage = parsedMessage.value;

    const domainEvent: DomainEvent = {
      eventId: redisMessage.eventId,
      type: redisMessage.eventType,
      timestamp: new Date(redisMessage.timestamp),
      aggregateId: redisMessage.aggregateId,
      aggregateVersion: redisMessage.aggregateVersion,
      correlationId: redisMessage.correlationId,
      causationId: redisMessage.causationId,
      payload: redisMessage.payload,
      metadata: redisMessage.metadata
    };

    const startTime = Date.now();

    // Вызываем обработчики всех подписчиков данного типа
    for (const subscriptionId of subs) {
      const subscriber = this.subscriptions.get(subscriptionId);
      if (!subscriber || !subscriber.handler) continue;

      try {
        // Обработка события
        await subscriber.handler(domainEvent);

        // Статистика по подписчику
        subscriber.processedCount++;
      } catch (error) {
        subscriber.errorCount++;
        this.metrics.eventsFailed++;

        this.logger?.error(
          `❌ Failed to process event ${domainEvent.type}:${domainEvent.eventId} for subscriber ${subscriptionId}:`,
          { error: String(error) }
        );

        // Отправка в DLQ при необходимости
        if (this.config.enableDeadLetterQueue &&
            EventBusUtils.shouldUseDeadLetterQueue(error as Error, subscriber.options)) {
          await this.addToDeadLetterQueue(redisMessage, error as Error, subscriptionId);
        }
      }
    }

    // Обновление метрик времени обработки
    const processingTime = Date.now() - startTime;
    if (EB_METRICS_ON) {
      EB_DISPATCH_LATENCY_MS.labels(domainEvent.type).observe(processingTime);
    }
    this.updateProcessingTime(processingTime);

    this.debug(`⚡ Dispatched event ${domainEvent.type}:${domainEvent.eventId} to ${subs.size} subscribers in ${processingTime}ms`);
  }

  /**
   * Запуск batch публикации с защитой от утечек в тестах
   */
  private startBatchPublishing(): void {
    const config = getConfig();
    const isTestEnv = Boolean(config.JEST_WORKER_ID || config.NODE_ENV === 'test');
    if (isTestEnv) {
      // В тестах отключаем batch publishing чтобы избежать утечек
      return;
    }

    const processBatchIfNeeded = async () => {
      if (this.publishQueue.length > 0 && !this.isClosed) {
        await this.processBatch();
      }

      if (!this.isClosed) {
        this.batchTimer = setTimeout(processBatchIfNeeded, this.config.batchInterval);
      }
    };

    // Запуск первого таймера
    this.batchTimer = setTimeout(processBatchIfNeeded, this.config.batchInterval);
  }

  /**
   * Обработка batch публикации
   */
  private async processBatch(): Promise<void> {
    if (this.publishQueue.length === 0) return;

    const batch = this.publishQueue.splice(0, this.config.batchSize);

    for (const { event, options } of batch) {
      try {
        await this.publish(event, options);
      } catch (error) {
        this.logger?.error('❌ Failed to publish event in batch:', { error: String(error) });
      }
    }
  }

  /**
   * Сбор метрик
   */
  private startMetricsCollection(): void {
    if (!this.config.enableMetrics) return;

    // В тестовой среде и при явном флаге отключаем метрики полностью
    const config = getConfig();
    const isTest = Boolean(config.JEST_WORKER_ID || config.NODE_ENV === 'test');
    if (isTest || config.REDIS_EVENT_BUS_METRICS === 'false') return;

    // В проде обновляем аптайм без логирования, чтобы не держать открытые хендлы в тестах
    this.metricsTimer = setInterval(() => {
      this.updateUptime();
    }, this.config.metricsInterval);
  }

  /**
   * Обновление времени работы
   */
  private updateUptime(): void {
    this.metrics.uptime = Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Обновление среднего времени обработки
   */
  private updateProcessingTime(processingTime: number): void {
    const alpha = 0.1; // EMA parameter
    this.metrics.averageProcessingTime =
      this.metrics.averageProcessingTime * (1 - alpha) + processingTime * alpha;
  }

  /**
   * Добавить событие в Dead Letter Queue
   */
  private async addToDeadLetterQueue(
    redisMessage: RedisEventMessage,
    error: Error,
    subscriberId?: string
  ): Promise<void> {
    try {
      const key = (this.config.keyPrefix || '') + EventBusUtils.createDeadLetterQueueKey(redisMessage.eventType);

      const dead: DeadLetterEvent = {
        originalEvent: {
          eventId: redisMessage.eventId,
          type: redisMessage.eventType,
          aggregateId: redisMessage.aggregateId,
          aggregateVersion: redisMessage.aggregateVersion,
          correlationId: redisMessage.correlationId,
          causationId: redisMessage.causationId,
          timestamp: new Date(redisMessage.timestamp),
          payload: redisMessage.payload,
          metadata: {
            ...(redisMessage.metadata || {}),
            subscriberId
          }
        },
        error: {
          message: error.message,
          stack: error.stack
        },
        deadLetterAt: new Date(),
        retryCount: 0,
        lastError: error
      };

      await this.redis.rpush(key, JSON.stringify(dead));

      const len = await this.redis.llen(key);
      const max = this.config.deadLetterQueueMaxSize;
      if (len > max) {
        // Оставляем только последние max элементов
        await this.redis.ltrim(key, len - max, -1);
      }
    } catch (e) {
      this.logger?.error('❌ Failed to push event to DLQ:', { error: String(e) });
    }
  }

  /**
   * Проверка инициализации
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('Event Bus is not initialized. Call initialize() first.');
    }
    if (this.isClosed) {
      throw new Error('Event Bus is closed');
    }
  }
}

/**
 * Фабрика для создания Redis Event Bus
 */
export function createRedisEventBus(config: RedisEventBusConfig): RedisEventBus {
  return new RedisEventBus(config);
}

/**
 * Создать Event Bus из переменных окружения
 */
export function createRedisEventBusFromEnv(): RedisEventBus {
  const base = getRedisEventBusConfig();
  const appConfig = getConfig();
  const isTestEnv = Boolean(appConfig.JEST_WORKER_ID || appConfig.NODE_ENV === 'test');

  const redisConfig: RedisEventBusConfig = {
    connection: { ...base.connection },
    keyPrefix: base.keyPrefix,
    batchSize: base.batchSize,
    batchInterval: base.batchInterval,
    defaultTimeoutMs: base.defaultTimeoutMs,
    defaultMaxRetries: base.defaultMaxRetries,
    retryDelayMs: base.retryDelayMs,
    enableDeadLetterQueue: base.enableDeadLetterQueue,
    deadLetterQueueMaxSize: base.deadLetterQueueMaxSize,
    // Жёстко отключаем метрики в тестовой среде, чтобы избежать открытых дескрипторов и логов после teardown
    enableMetrics: isTestEnv ? false : base.enableMetrics,
    metricsInterval: base.metricsInterval
  };

  return createRedisEventBus(redisConfig);
}