/**
 * Event Bus Interface - система публикации и подписки на события
 * Layer: Domain (контракты)
 *
 * Event Bus обеспечивает асинхронную доставку событий между компонентами системы
 * через паттерн Publish-Subscribe. Поддерживает различные транспорты и реализации.
 */

import { DomainEvent } from './event-store.interface';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { IdGenerator } from '../../core/utils/IdGenerator';

/**
 * Тип обработчика события
 */
export type EventHandler<T extends DomainEvent = DomainEvent> = (event: T) => Promise<void> | void;

/**
 * Опции подписки на событие
 */
export interface SubscriptionOptions {
  /** Приоритет обработчика (влияет на порядок выполнения) */
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  /** Максимальное количество попыток при ошибке */
  maxRetries?: number;
  /** Таймаут обработки в миллисекундах */
  timeoutMs?: number;
  /** Использовать dead letter queue при ошибках */
  enableDeadLetterQueue?: boolean;
  /** Дополнительные метаданные подписки */
  metadata?: Record<string, unknown>;
}

/**
 * Опции публикации события
 */
export interface PublishOptions {
  /** Автоматически генерировать correlation_id если отсутствует */
  autoGenerateCorrelationId?: boolean;
  /** Сохранить события в Event Store */
  persistEvents?: boolean;
  /** Таймаут публикации в миллисекундах */
  timeoutMs?: number;
  /** Приоритет события */
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  /** Метаданные публикации */
  metadata?: Record<string, unknown>;
  /** Максимальное количество параллельных обработчиков (для защиты от P0-007) */
  concurrencyLimit?: number;
  /**
   * Сигнал прерывания для Deep Preemption.
   * При вызове abort() публикация будет немедленно отменена.
   * @singularity ADR-013 Deep Preemption
   */
  signal?: AbortSignal;
}

/**
 * Метрики Event Bus
 */
export interface EventBusMetrics {
  /** Общее количество опубликованных событий */
  eventsPublished: number;
  /** Количество событий с ошибками */
  eventsFailed: number;
  /** Среднее время обработки события (мс) */
  averageProcessingTime: number;
  /** Количество подписчиков */
  subscriberCount: number;
  /** Количество каналов/топиков */
  channelCount: number;
  /** Время работы системы */
  uptime: number;
}

/**
 * Информация о подписчике
 */
export interface SubscriberInfo {
  /** Уникальный ID подписчика */
  subscriberId: string;
  /** Тип события */
  eventType: string;
  /** Callback функция (опционально для предотвращения утечек памяти) */
  handler?: EventHandler;
  /** Опции подписки */
  options: SubscriptionOptions;
  /** Время регистрации */
  registeredAt: Date;
  /** Количество обработанных событий */
  processedCount: number;
  /** Количество ошибок */
  errorCount: number;
}

/**
 * Интерфейс Event Bus
 * 
 * Обеспечивает:
 * - Публикацию событий
 * - Подписку на события по типу
 * - Batch публикацию
 * - Dead Letter Queue для неудачных событий
 * - Метрики и мониторинг
 */
export interface IEventBus {
  /**
   * Опубликовать событие
   * 
   * @param event - Событие для публикации
   * @param options - Опции публикации
   * @returns Promise<void>
   */
  publish<T extends DomainEvent>(event: T, options?: PublishOptions): Promise<void>;

  /**
   * Опубликовать несколько событий
   * 
   * @param events - Массив событий
   * @param options - Опции публикации
   * @returns Promise<void>
   */
  publishBatch<T extends DomainEvent>(events: T[], options?: PublishOptions): Promise<void>;

  /**
   * Подписаться на события указанного типа
   *
   * @param eventType - Тип события
   * @param handler - Обработчик события
   * @param options - Опции подписки
   * @returns Promise<string> - ID подписки
   */
  subscribe(
    eventType: string,
    handler: EventHandler,
    options?: SubscriptionOptions
  ): Promise<string>;

  /**
   * Отписаться от событий
   * 
   * @param subscriptionId - ID подписки
   * @returns Promise<void>
   */
  unsubscribe(subscriptionId: string): Promise<void>;

  /**
   * Отписаться от всех событий указанного типа
   * 
   * @param eventType - Тип события
   * @returns Promise<void>
   */
  unsubscribeAll(eventType: string): Promise<void>;

  /**
   * Проверить статус подписки
   * 
   * @param subscriptionId - ID подписки
   * @returns Promise<boolean> - true если подписка активна
   */
  isSubscribed(subscriptionId: string): Promise<boolean>;

  /**
   * Получить количество подписчиков на тип события
   * 
   * @param eventType - Тип события
   * @returns Promise<number> - Количество подписчиков
   */
  getSubscriberCount(eventType: string): Promise<number>;

  /**
   * Получить информацию о подписчике
   * 
   * @param subscriptionId - ID подписки
   * @returns Promise<SubscriberInfo | null>
   */
  getSubscriberInfo(subscriptionId: string): Promise<SubscriberInfo | null>;

  /**
   * Получить все подписки
   * 
   * @returns Promise<SubscriberInfo[]> - Список всех подписок
   */
  getAllSubscriptions(): Promise<SubscriberInfo[]>;

  /**
   * Получить метрики Event Bus
   * 
   * @returns Promise<EventBusMetrics> - Метрики работы
   */
  getMetrics(): Promise<EventBusMetrics>;

  /**
   * Проверить здоровье системы
   * 
   * @returns Promise<boolean> - true если система работает корректно
   */
  isHealthy(): Promise<boolean>;

  /**
   * Получить события из Dead Letter Queue
   * 
   * @param eventType - Тип события (опционально)
   * @param limit - Максимальное количество событий
   * @returns Promise<DeadLetterEvent[]> - События из DLQ
   */
  getDeadLetterQueue(eventType?: string, limit?: number): Promise<DeadLetterEvent[]>;

  /**
   * Повторить обработку события из Dead Letter Queue
   * 
   * @param deadLetterEvent - Событие из DLQ
   * @returns Promise<void>
   */
  replayDeadLetterEvent(deadLetterEvent: DeadLetterEvent): Promise<void>;

  /**
   * Очистить Dead Letter Queue
   * 
   * @param eventType - Тип события (опционально)
   * @returns Promise<void>
   */
  clearDeadLetterQueue(eventType?: string): Promise<void>;

  /**
   * Инициализировать Event Bus
   */
  initialize(): Promise<void>;
  /**
   * Закрыть Event Bus
   */
  close(): Promise<void>;
}

/**
 * Событие в Dead Letter Queue
 */
export interface DeadLetterEvent {
  /** Оригинальное событие */
  originalEvent: DomainEvent;
  /** Ошибка обработки */
  error: {
    message: string;
    code?: string;
    stack?: string;
  };
  /** Время попадания в DLQ */
  deadLetterAt: Date;
  /** Количество попыток обработки */
  retryCount: number;
  /** Последняя ошибка */
  lastError?: Error;
}

/**
 * Статус обработки события
 */
export interface EventProcessingStatus {
  /** ID события */
  eventId: string;
  /** Статус обработки */
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRYING';
  /** Время начала обработки */
  startedAt?: Date;
  /** Время завершения обработки */
  completedAt?: Date;
  /** Время последней попытки */
  lastRetryAt?: Date;
  /** Количество попыток */
  retryCount: number;
  /** Последняя ошибка */
  lastError?: string;
  /** ID подписчика */
  subscriberId?: string;
}

/**
 * Ошибка Event Bus
 */
export class EventBusError extends Error {
  constructor(
    message: string,
    public readonly eventType?: string,
    public readonly subscriberId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'EventBusError';
  }

  static eventTypeNotFound(eventType: string): EventBusError {
    return new EventBusError(`Event type not found: ${eventType}`, eventType);
  }

  static subscriberNotFound(subscriptionId: string): EventBusError {
    return new EventBusError(`Subscriber not found: ${subscriptionId}`, undefined, subscriptionId);
  }

  static handlerTimeout(eventType: string, timeoutMs: number): EventBusError {
    return new EventBusError(`Handler timeout for event ${eventType} after ${timeoutMs}ms`, eventType);
  }

  static maxRetriesExceeded(eventType: string, maxRetries: number): EventBusError {
    return new EventBusError(`Max retries exceeded for event ${eventType} (${maxRetries})`, eventType);
  }

  static publishFailed(eventType: string, cause?: Error): EventBusError {
    return new EventBusError(`Failed to publish event ${eventType}`, eventType, undefined, cause);
  }

  static subscribeFailed(eventType: string, cause?: Error): EventBusError {
    return new EventBusError(`Failed to subscribe to event ${eventType}`, eventType, undefined, cause);
  }
}

/**
 * Контекст обработки события
 */
export interface EventProcessingContext {
  /** ID события */
  eventId: string;
  /** Тип события */
  eventType: string;
  /** Correlation ID */
  correlationId: string;
  /** Время начала обработки */
  startedAt: Date;
  /** ID подписчика */
  subscriberId?: string;
  /** Метаданные контекста */
  metadata?: Record<string, unknown>;
}

/**
 * Утилиты для Event Bus
 */
export class EventBusUtils {
  /**
   * Сгенерировать уникальный ID подписки
   */
  static generateSubscriptionId(): string {
    return IdGenerator.generateWithPrefix('sub');
  }

  /**
   * Сгенерировать Correlation ID
   */
  static generateCorrelationId(): string {
    return CorrelationIdProvider.generate('corr');
  }

  /**
   * Создать ключ канала для типа события
   */
  static createChannelKey(eventType: string): string {
    return `events:${eventType}`;
  }

  /**
   * Создать ключ Dead Letter Queue для типа события
   */
  static createDeadLetterQueueKey(eventType: string): string {
    return `dlq:${eventType}`;
  }

  /**
   * Валидировать тип события
   */
  static isValidEventType(eventType: string): boolean {
    return typeof eventType === 'string' && eventType.length > 0 && eventType.length <= 100;
  }

  /**
   * Нормализовать приоритет подписки
   */
  static normalizePriority(priority?: string): 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' {
    switch (priority?.toUpperCase()) {
      case 'LOW': return 'LOW';
      case 'HIGH': return 'HIGH';
      case 'CRITICAL': return 'CRITICAL';
      default: return 'NORMAL';
    }
  }

  /**
   * Сортировать обработчики по приоритету
   */
  static sortHandlersByPriority(handlers: Array<{ handler: EventHandler; priority: SubscriptionOptions['priority'] }>): Array<{ handler: EventHandler; priority: number }> {
    const priorityOrder = { 'LOW': 1, 'NORMAL': 2, 'HIGH': 3, 'CRITICAL': 4 };
    
    return handlers
      .map(h => ({
        handler: h.handler,
        priority: priorityOrder[h.priority || 'NORMAL']
      }))
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Создать описательное сообщение об ошибке
   */
  static formatErrorMessage(event: DomainEvent, error: Error, context?: EventProcessingContext): string {
    const parts = [
      `Event processing failed: ${event.type}`,
      `Event ID: ${event.eventId}`,
      `Aggregate ID: ${event.aggregateId}`,
      `Correlation ID: ${event.correlationId}`
    ];

    if (context?.subscriberId) {
      parts.push(`Subscriber ID: ${context.subscriberId}`);
    }

    parts.push(`Error: ${error.message}`);

    if (error.stack) {
      parts.push(`Stack: ${error.stack}`);
    }

    return parts.join('\n');
  }

  /**
   * Проверить, нужно ли использовать Dead Letter Queue
   */
  static shouldUseDeadLetterQueue(error: Error, options: SubscriptionOptions): boolean {
    if (!options.enableDeadLetterQueue) return false;
    
    // Не помещаем в DLQ временные ошибки
    const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
    const isTransient = transientErrors.some(code => error.message.includes(code));
    
    return !isTransient;
  }
}

/**
 * Фабрика для создания обработчиков событий
 */
export class EventHandlerFactory {
  /**
   * Создать обработчик с логированием
   */
  static createLoggingHandler<T extends DomainEvent>(
    handler: EventHandler<T>,
    logger?: Console
  ): EventHandler<T> {
    return async (event: T) => {
      const startTime = Date.now();
      
      try {
        logger?.log(`Processing event ${event.type}:${event.eventId}`);
        await handler(event);
        const duration = Date.now() - startTime;
        logger?.log(`Event ${event.type}:${event.eventId} processed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        logger?.error(`Event ${event.type}:${event.eventId} failed after ${duration}ms:`, error);
        throw error;
      }
    };
  }

  /**
   * Создать обработчик с таймаутом
   */
  static createTimeoutHandler<T extends DomainEvent>(
    handler: EventHandler<T>,
    timeoutMs: number
  ): EventHandler<T> {
    return async (event: T) => {
      let timer: NodeJS.Timeout | undefined;

      const timeoutPromise = new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(EventBusError.handlerTimeout(event.type, timeoutMs));
        }, timeoutMs);
      });

      try {
        await Promise.race([handler(event), timeoutPromise]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }

  /**
   * Создать обработчик с retry логикой
   */
  static createRetryHandler<T extends DomainEvent>(
    handler: EventHandler<T>,
    maxRetries: number,
    retryDelay: number
  ): EventHandler<T> {
    return async (event: T) => {
      let lastError: Error | undefined;
      
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await handler(event);
          return; // Успех
        } catch (error) {
          lastError = error as Error;
          
          if (attempt < maxRetries) {
            const delay = retryDelay * Math.pow(2, attempt); // Экспоненциальная задержка
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      
      throw EventBusError.maxRetriesExceeded(event.type, maxRetries);
    };
  }
}