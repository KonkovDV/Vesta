/**
 * Outbox Interface - паттерн надежной доставки событий
 * Layer: Domain (контракты)
 *
 * Outbox паттерн обеспечивает транзакционность между сохранением доменных событий
 * и их публикацией в Event Bus, предотвращая потерю событий при сбоях.
 */

import { DomainEvent } from './event-store.interface';
import { IdGenerator } from '../../core/utils/IdGenerator';

/**
 * Статус обработки события в Outbox
 */
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';

/**
 * Сообщение в Outbox для надежной доставки
 */
export interface OutboxMessage {
  /** Уникальный ID сообщения */
  messageId: string;
  /** Связанное доменное событие */
  event: DomainEvent;
  /** Статус обработки */
  status: OutboxStatus;
  /** Количество попыток публикации */
  retryCount: number;
  /** Время создания записи в outbox */
  createdAt: Date;
  /** Время последней попытки публикации */
  lastRetryAt?: Date;
  /** Время успешной публикации */
  publishedAt?: Date;
  /** Последняя ошибка */
  lastError?: string;
  /** Метаданные обработки */
  metadata?: Record<string, unknown>;

  /** ID транзакции, в рамках которой записаны события и outbox */
  transactionId?: string;

  /** Оригинальный timestamp доменного события */
  eventTimestamp: Date;
  /** Версия агрегата (из доменного события) */
  aggregateVersion: number;
  /**
   * Денормализованный Global Sequence Number (GSN) из Event Store.
   * Читается из event_store.events.gsn / outbox.messages.event_gsn; может быть undefined для старых записей.
   */
  eventGsn?: number;
  /** Оригинальный causationId события */
  causationId?: string;
  /** Ключ идемпотентности */
  idempotencyKey?: string;
}

/**
 * Конфигурация Outbox
 */
export interface OutboxConfig {
  /** Максимальное количество попыток публикации */
  maxRetries?: number;
  /** Задержка между попытками (мс) */
  retryDelayMs?: number;
  /** Размер батча для обработки */
  batchSize?: number;
  /** Интервал обработки (мс) */
  processingIntervalMs?: number;
  /** Таймаут обработки сообщения (мс) */
  processingTimeoutMs?: number;
  /** Включить dead letter queue */
  enableDeadLetterQueue?: boolean;
  /** Таймаут circuit breaker (мс) перед переходом из OPEN в HALF_OPEN */
  circuitBreakerTimeoutMs?: number;
  /** Количество успешных батчей в HALF_OPEN для возврата в CLOSED */
  circuitBreakerSuccessThreshold?: number;
  /** Количество подряд неудачных батчей для перехода в OPEN */
  circuitBreakerFailureThreshold?: number;
}

/**
 * Статистика Outbox
 */
export interface OutboxStats {
  /** Общее количество сообщений */
  totalMessages: number;
  /** Количество ожидающих сообщений */
  pendingMessages: number;
  /** Количество обрабатываемых сообщений */
  processingMessages: number;
  /** Количество опубликованных сообщений */
  publishedMessages: number;
  /** Количество неудачных сообщений */
  failedMessages: number;
  /** Количество сообщений в DLQ */
  deadLetterMessages: number;
  /** Среднее время публикации (мс) */
  averagePublishTime: number;
  /** Последнее сообщение */
  lastMessageAt?: Date;
}

/**
 * Результат операции публикации
 */
export interface PublishResult {
  /** Успешность операции */
  success: boolean;
  /** Опубликованные сообщения */
  publishedMessages: string[];
  /** Неудачные сообщения */
  failedMessages: Array<{ messageId: string; error: string }>;
  /** Время выполнения (мс) */
  processingTime: number;
}

/**
 * Интерфейс Outbox для надежной доставки событий
 *
 * Обеспечивает:
 * - Транзакционную запись событий и outbox сообщений
 * - Асинхронную публикацию в Event Bus
 * - Retry логику при ошибках публикации
 * - Dead Letter Queue для проблемных сообщений
 * - Мониторинг и статистику
 */
export interface IOutbox {
  /**
   * Сохранить события в Event Store и создать outbox сообщения (в одной транзакции)
   *
   * @param events - Доменные события для сохранения
   * @param transactionId - ID транзакции для группировки
   * @returns Promise<OutboxMessage[]> - Созданные outbox сообщения
   */
  saveEventsWithOutbox(events: DomainEvent[], transactionId?: string): Promise<OutboxMessage[]>;

  /**
   * Обработать все pending сообщения из outbox
   *
   * @param batchSize - Размер батча для обработки
   * @returns Promise<PublishResult> - Результат публикации
   */
  processPendingMessages(batchSize?: number): Promise<PublishResult>;

  /**
   * Обработать конкретное сообщение из outbox
   *
   * @param messageId - ID сообщения
   * @returns Promise<boolean> - true если сообщение успешно опубликовано
   */
  processMessage(messageId: string): Promise<boolean>;

  /**
   * Повторить обработку неудачного сообщения
   *
   * @param messageId - ID сообщения
   * @returns Promise<boolean> - true если сообщение успешно опубликовано
   */
  retryMessage(messageId: string): Promise<boolean>;

  /**
   * Переместить сообщение в Dead Letter Queue
   *
   * @param messageId - ID сообщения
   * @param reason - Причина перемещения в DLQ
   * @returns Promise<void>
   */
  moveToDeadLetterQueue(messageId: string, reason: string): Promise<void>;

  /**
   * Получить сообщения из Dead Letter Queue
   *
   * @param limit - Максимальное количество сообщений
   * @returns Promise<OutboxMessage[]> - Сообщения из DLQ
   */
  getDeadLetterMessages(limit?: number): Promise<OutboxMessage[]>;

  /**
   * Повторить обработку сообщения из Dead Letter Queue
   *
   * @param messageId - ID сообщения
   * @returns Promise<boolean> - true если сообщение успешно опубликовано
   */
  replayDeadLetterMessage(messageId: string): Promise<boolean>;

  /**
   * Получить статистику outbox
   *
   * @returns Promise<OutboxStats> - Статистика работы
   */
  getStats(): Promise<OutboxStats>;

  /**
   * Проверить здоровье outbox
   *
   * @returns Promise<boolean> - true если система работает корректно
   */
  isHealthy(): Promise<boolean>;

  /**
   * Очистить старые сообщения
   *
   * @param olderThanDays - Удалять сообщения старше указанного количества дней
   * @returns Promise<number> - Количество удаленных сообщений
   */
  cleanupOldMessages(olderThanDays: number): Promise<number>;

  /**
   * Запустить фоновую обработку outbox
   *
   * @returns Promise<void>
   */
  startProcessing(): Promise<void>;

  /**
   * Остановить фоновую обработку outbox
   *
   * @returns Promise<void>
   */
  stopProcessing(): Promise<void>;

  /**
   * Закрыть outbox
   *
   * @returns Promise<void>
   */
  close(): Promise<void>;
}

/**
 * Ошибка Outbox
 */
export class OutboxError extends Error {
  constructor(
    message: string,
    public readonly messageId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'OutboxError';
  }

  static messageNotFound(messageId: string): OutboxError {
    return new OutboxError(`Outbox message not found: ${messageId}`, messageId);
  }

  static publishFailed(messageId: string, cause?: Error): OutboxError {
    return new OutboxError(`Failed to publish outbox message: ${messageId}`, messageId, cause);
  }

  static maxRetriesExceeded(messageId: string, _maxRetries: number): OutboxError {
    return new OutboxError(`Max retries exceeded for message: ${messageId}`, messageId);
  }

  static invalidMessage(message: unknown): OutboxError {
    return new OutboxError('Invalid outbox message structure', undefined, new Error(JSON.stringify(message)));
  }

  static configurationError(message: string): OutboxError {
    return new OutboxError(`Outbox configuration error: ${message}`);
  }
}

/**
 * Утилиты для работы с Outbox
 */
export class OutboxUtils {
  private static normalizeEventGsn(eventGsn: number | string | bigint | undefined): number | undefined {
    if (eventGsn === undefined || eventGsn === null) {
      return undefined;
    }

    const numericGsn =
      typeof eventGsn === 'number'
        ? eventGsn
        : typeof eventGsn === 'bigint'
        ? Number(eventGsn)
        : Number(eventGsn);

    return Number.isFinite(numericGsn) ? numericGsn : undefined;
  }

  /**
   * Сгенерировать уникальный ID сообщения
   */
  static generateMessageId(): string {
    return IdGenerator.generateWithPrefix('outbox');
  }

  /**
   * Создать outbox сообщение из доменного события
   */
  static createOutboxMessage(
    event: DomainEvent,
    transactionId?: string,
    eventGsn?: number | string | bigint
  ): OutboxMessage {
    const now = new Date();
    return {
      messageId: OutboxUtils.generateMessageId(),
      event,
      status: 'PENDING',
      retryCount: 0,
      createdAt: now,
      lastRetryAt: undefined,
      publishedAt: undefined,
      lastError: undefined,
      metadata: {
        created_at: now.toISOString(),
        event_type: event.type,
        aggregate_id: event.aggregateId,
        correlation_id: event.correlationId
      },
      transactionId,
      eventTimestamp: event.timestamp,
      aggregateVersion: event.aggregateVersion,
      eventGsn: OutboxUtils.normalizeEventGsn(eventGsn),
      causationId: event.causationId,
      idempotencyKey: event.idempotencyKey,
    };
  }

  /**
   * Проверить валидность outbox сообщения
   */
  static isValidOutboxMessage(message: unknown): message is OutboxMessage {
    if (!message || typeof message !== 'object') return false;

    const m = message as OutboxMessage;

    return typeof m.messageId === 'string' &&
           typeof m.event === 'object' &&
           typeof m.status === 'string' &&
           typeof m.retryCount === 'number' &&
           m.createdAt instanceof Date;
  }

  /**
   * Вычислить задержку для retry с экспоненциальным backoff
   */
  static calculateRetryDelay(retryCount: number, baseDelayMs: number): number {
    return Math.min(baseDelayMs * Math.pow(2, retryCount), 300000); // Максимум 5 минут
  }

  /**
   * Проверить, нужно ли переместить сообщение в DLQ
   */
  static shouldMoveToDeadLetter(message: OutboxMessage, maxRetries: number, error: Error): boolean {
    return message.retryCount >= maxRetries &&
           !OutboxUtils.isTransientError(error);
  }

  /**
   * Проверить, является ли ошибка временной
   */
  static isTransientError(error: Error): boolean {
    const transientErrorMessages = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNREFUSED',
      'timeout',
      'network',
      'temporarily unavailable'
    ];

    const errorMessage = error.message.toLowerCase();
    return transientErrorMessages.some(transient =>
      errorMessage.includes(transient.toLowerCase())
    );
  }
}