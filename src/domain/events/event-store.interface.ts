/**
 * Event Store Interface - система событийного хранилища
 * Layer: Domain (контракты)
 *
 * Event Store обеспечивает персистентность доменных событий для реализации
 * Event Sourcing паттерна. События сохраняются неизменяемыми и могут быть
 * воспроизведены для восстановления состояния агрегата.
 */

import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { IdGenerator } from '../../core/utils/IdGenerator';

/**
 * Базовый интерфейс доменного события
 * Содержит обязательные поля для Event Sourcing
 */
export interface DomainEvent {
  /** Уникальный ID события */
  eventId: string;
  /** Тип события (canonical) */
  type: string;
  /**
   * Алиас для типа события, используемый observability‑тестами и
   * внешними потребителями.
   *
   * В runtime всегда дублирует значение поля `type`.
   */
  eventType?: string;
  /** Временная метка события */
  timestamp: Date;
  /** ID агрегата, к которому относится событие */
  aggregateId: string;
  /** Версия агрегата на момент события */
  aggregateVersion: number;
  /**
   * Global Sequence Number (GSN) — infra‑поле глобального порядка событий.
   * Выставляется Event Store при чтении из хранилища; может быть undefined для исторических записей.
   */
  gsn?: number;
  /** Correlation ID для отслеживания цепочки вызовов */
  correlationId: string;
  /** Causation ID - ID события, вызвавшего данное событие */
  causationId?: string;
  /** Ключ идемпотентности для дедупликации */
  idempotencyKey?: string;
  /** Метаданные события */
  metadata?: Record<string, unknown>;
  /**
   * Версия схемы payload события.
   *
   * Используется для эволюции структуры события (schema versioning) и
   * применения upcasters при чтении из Event Store.
   *
   * Отсчёт начинается с 1; если поле не задано, считается, что schemaVersion = 1.
   */
  schemaVersion?: number;
  /** Payload события (унифицированный формат) */
  payload: Record<string, unknown>;
}

/**
 * Интерфейс для системы событийного хранилища
 *
 * Обеспечивает:
 * - Сохранение событий (append-only)
 * - Получение событий по aggregateId
 * - Получение событий по correlationId
 * - Получение событий по типу
 * - Получение событий по глобальному порядковому номеру (GSN)
 * - Получение последней версии агрегата
 * - Проверка существования агрегата
 */
export interface IEventStore {
  /**
   * Сохранить события в хранилище
   * 
   * @param events - Массив событий для сохранения
   * @param options - Опции сохранения
   * @returns Promise<void>
   */
  saveEvents(events: DomainEvent[], options?: SaveEventsOptions): Promise<SaveEventsResult>;

  /**
   * Получить все события агрегата
   * 
   * @param aggregateId - ID агрегата
   * @param fromVersion - Начальная версия (по умолчанию 1)
   * @returns Promise<DomainEvent[]> - События в хронологическом порядке
   */
  getEvents(aggregateId: string, fromVersion?: number): Promise<DomainEvent[]>;

  /**
   * Получить события по Correlation ID
   * 
   * Используется для трассировки цепочки операций
   * 
   * @param correlationId - Correlation ID
   * @returns Promise<DomainEvent[]> - Связанные события
   */
  getEventsByCorrelationId(correlationId: string): Promise<DomainEvent[]>;

  /**
   * Получить события по Causation ID
   * 
   * @param causationId - Causation ID
   * @returns Promise<DomainEvent[]> - Вызванные события
   */
  getEventsByCausationId(causationId: string): Promise<DomainEvent[]>;

  /**
   * Получить события по типу
   * 
   * @param eventType - Тип события
   * @param fromDate - Начальная дата (опционально)
   * @returns Promise<DomainEvent[]> - События указанного типа
   */
  getEventsByType(eventType: string, fromDate?: Date): Promise<DomainEvent[]>;

  /**
   * Получить события по глобальному порядковому номеру (GSN).
   *
   * Если fromExclusiveGsn === null — чтение начинается с минимального доступного GSN.
   * В противном случае возвращаются события с gsn > fromExclusiveGsn.
   *
   * @param fromExclusiveGsn - Последний уже обработанный GSN (исключительно) или null для чтения с начала истории
   * @param limit - Максимальное количество событий для выборки (должно быть > 0)
   * @returns Promise<DomainEvent[]> - События, отсортированные по GSN (ASC)
   */
  getEventsByGsnRange(
    fromExclusiveGsn: number | null,
    limit: number,
  ): Promise<DomainEvent[]>;

  /**
   * Получить максимальный GSN в Event Store.
   *
   * @returns Promise<number | null> - Последний GSN или null, если в хранилище ещё нет событий
   */
  getLatestGsn(): Promise<number | null>;

  /**
   * Получить последнюю версию агрегата
   *
   * @param aggregateId - ID агрегата
   * @returns Promise<number> - Последняя версия агрегата (0 если агрегат не существует)
   */
  getLatestEventVersion(aggregateId: string): Promise<number>;

  /**
   * Проверить существование агрегата
   * 
   * @param aggregateId - ID агрегата
   * @returns Promise<boolean> - true если агрегат существует
   */
  exists(aggregateId: string): Promise<boolean>;

  /**
   * Получить количество событий агрегата
   * 
   * @param aggregateId - ID агрегата
   * @returns Promise<number> - Количество событий
   */
  getEventCount(aggregateId: string): Promise<number>;

  /**
   * Итератор событий агрегата
   * 
   * Используется для воспроизведения событий (event replay)
   * 
   * @param aggregateId - ID агрегата
   * @param fromVersion - Начальная версия
   * @returns AsyncIterable<DomainEvent> - Итератор событий
   */
  getEventStream(aggregateId: string, fromVersion?: number): AsyncIterable<DomainEvent>;

  /**
   * Получить статистику Event Store
   * 
   * @returns Promise<EventStoreStats> - Статистика хранилища
   */
  getStats(): Promise<EventStoreStats>;

  /**
   * Проверить подключение к хранилищу
   * 
   * @returns Promise<boolean> - true если хранилище доступно
   */
  isHealthy(): Promise<boolean>;

/** Инициализировать хранилище */
initialize(): Promise<void>;

/** Закрыть соединения и ресурсы */
close(): Promise<void>;

  /**
   * Создать snapshot агрегата
   * 
   * @param aggregateId - ID агрегата
   * @param version - Версия агрегата
   * @param snapshot - Данные snapshot
   * @returns Promise<void>
   */
  saveSnapshot(aggregateId: string, version: number, snapshot: Record<string, unknown>): Promise<void>;

  /**
   * Получить snapshot агрегата
   * 
   * @param aggregateId - ID агрегата
   * @param maxVersion - Максимальная версия snapshot
   * @returns Promise<Snapshot | null> - Snapshot или null
   */
  getSnapshot(aggregateId: string, maxVersion?: number): Promise<Snapshot | null>;

  // ─── Semantic Event Sourcing (Этап 6) ───────────────────

  /**
   * Update semantic embeddings for events (batch).
   *
   * Called by SemanticEmbeddingWorker after vectorization.
   * Events without a semantic_embedding column are simply skipped.
   *
   * @param updates - Array of {eventId, embedding} pairs
   */
  updateEventEmbeddings(updates: import('../memory/IEventVectorizer').EventEmbeddingUpdate[]): Promise<void>;

  /**
   * Find events semantically similar to the given query vector.
   *
   * Uses pgvector cosine distance (<=> operator) with HNSW index.
   * Returns empty array if semantic search is disabled or no embeddings exist.
   *
   * @param queryVector - Dense float embedding of the search query
   * @param limit - Maximum number of results (1..100)
   * @param options - Optional namespace filter and minimum similarity threshold
   * @returns Events sorted by descending similarity
   */
  getSemanticallySimilarEvents(
    queryVector: number[],
    limit: number,
    options?: { namespace?: string; minSimilarity?: number },
  ): Promise<import('../memory/IEventVectorizer').SemanticEventResult[]>;
}

/**
 * Опции сохранения событий
 */
export interface SaveEventsOptions {
  /** Автоматически генерировать correlation_id если отсутствует */
  autoGenerateCorrelationId?: boolean;
  /** Режим транзакции (по умолчанию атомарный) */
  transactional?: boolean;
  /** Валидировать события перед сохранением */
  validateEvents?: boolean;
  /**
   * Ожидаемая версия агрегата для оптимистичного контроля конкуренции.
   *
   * Если указана, реализация IEventStore должна сравнивать текущую версию
   * агрегата в хранилище с переданным значением и выбрасывать ConcurrencyError
   * (или совместимую доменную ошибку), если версии не совпадают.
   */
  expectedAggregateVersion?: number;
  /** Таймаут операции в миллисекундах */
  timeoutMs?: number;
}

/**
 * Статистика Event Store
 */
export interface EventStoreStats {
  /** Общее количество событий */
  totalEvents: number;
  /** Количество уникальных агрегатов */
  totalAggregates: number;
  /** Количество событий по типам */
  eventsByType: Record<string, number>;
  /** Средний размер события в байтах */
  averageEventSize: number;
  /** Последнее событие */
  lastEventAt?: Date;
  /** Объем данных в байтах */
  totalSize: number;
  /** Количество snapshots */
  totalSnapshots: number;
}

/**
 * Snapshot агрегата для оптимизации производительности
 */
export interface Snapshot {
  aggregateId: string;
  version: number;
  timestamp: Date;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Ошибка Event Store
 */
export class EventStoreError extends Error {
  constructor(
    message: string,
    public readonly eventId?: string,
    public readonly aggregateId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'EventStoreError';
  }

  static eventAlreadyExists(eventId: string): EventStoreError {
    return new EventStoreError(`Event with ID ${eventId} already exists`, eventId);
  }

  static aggregateVersionConflict(aggregateId: string, expectedVersion: number, actualVersion: number): EventStoreError {
    return new EventStoreError(
      `Aggregate ${aggregateId} version conflict: expected ${expectedVersion}, got ${actualVersion}`,
      undefined,
      aggregateId
    );
  }

  static invalidEvent(event: unknown): EventStoreError {
    return new EventStoreError('Invalid event structure', undefined, undefined, new Error(JSON.stringify(event)));
  }

  static connectionFailed(cause?: Error): EventStoreError {
    return new EventStoreError('Failed to connect to event store', undefined, undefined, cause);
  }

  static saveFailed(eventId: string, cause?: Error): EventStoreError {
    return new EventStoreError(`Failed to save event ${eventId}`, eventId, undefined, cause);
  }

  static loadFailed(aggregateId: string, cause?: Error): EventStoreError {
    return new EventStoreError(`Failed to load events for aggregate ${aggregateId}`, undefined, aggregateId, cause);
  }
}

/**
 * Результат операции сохранения событий
 */
export interface SaveEventsResult {
  /** Успешность операции */
  success: boolean;
  /** Количество сохраненных событий */
  savedCount: number;
  /** Временная метка сохранения */
  savedAt: Date;
  /** Версия агрегата после сохранения */
  aggregateVersion: number;
  /** Список сохраненных событий с их ID */
  savedEvents: Array<{ eventId: string; type: string }>;
  /** Ошибки (если есть) */
  errors?: Array<{ eventId: string; error: string }>;
}

/**
 * Фабричные методы для создания стандартных событий
 */
export class EventFactory {
  /**
   * Создать базовое доменное событие с типобезопасным payload.
   *
   * Generic-параметр TPayload позволяет facade-слоям работать
   * с строго типизированными payload'ами без двойного кастинга.
   */
  static createBaseEvent<TPayload extends Record<string, unknown>>(
    aggregateId: string,
    eventType: string,
    payload: TPayload,
    correlationId?: string,
    causationId?: string
  ): DomainEvent & { payload: TPayload } {
    const timestamp = new Date();
    const eventId = EventFactory.generateEventId(aggregateId);

    const normalizedCorrelation = CorrelationIdProvider.normalize(correlationId);

    return {
      eventId,
      type: eventType,
      eventType,
      timestamp,
      aggregateId,
      aggregateVersion: 0, // Будет установлен при сохранении
      correlationId: normalizedCorrelation,
      causationId,
      metadata: {
        created_at: timestamp.toISOString(),
        version: '1.0.0',
      },
      schemaVersion: 1,
      payload,
    };
  }

  /**
   * Сгенерировать уникальный ID события
   */
  private static generateEventId(aggregateId: string): string {
    const timestamp = Date.now();
    const random = IdGenerator.generateRandomString(9);
    return `evt_${aggregateId}_${timestamp}_${random}`;
  }

  /**
   * Сгенерировать correlation ID
   */
  private static generateCorrelationId(): string {
    return CorrelationIdProvider.generate('corr');
  }
}

/**
 * Утилиты для работы с событиями
 */
export class EventUtils {
  /**
   * Проверить, что событие валидно
   */
  static isValidEvent(event: unknown): event is DomainEvent {
    if (!event || typeof event !== 'object') return false;
    
    const e = event as DomainEvent;
    
    return typeof e.eventId === 'string' &&
           typeof e.type === 'string' &&
           e.timestamp instanceof Date &&
           typeof e.aggregateId === 'string' &&
           typeof e.aggregateVersion === 'number' &&
           typeof e.correlationId === 'string' &&
           typeof e.payload === 'object';
  }

  /**
   * Проверить версионность событий
   */
  static validateEventSequence(events: DomainEvent[]): void {
    if (events.length === 0) return;

    // Проверяем, что события отсортированы по версии
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      
      if (curr.aggregateVersion !== prev.aggregateVersion + 1) {
        throw new EventStoreError(
          `Event version gap: expected ${prev.aggregateVersion + 1}, got ${curr.aggregateVersion}`,
          curr.eventId,
          curr.aggregateId
        );
      }
    }
  }

  /**
   * Группировать события по correlationId
   */
  static groupByCorrelationId(events: DomainEvent[]): Map<string, DomainEvent[]> {
    const grouped = new Map<string, DomainEvent[]>();
    
    for (const event of events) {
      let group = grouped.get(event.correlationId);
      if (!group) {
        group = [];
        grouped.set(event.correlationId, group);
      }
      group.push(event);
    }
    
    return grouped;
  }

  /**
   * Создать цепочку событий (event chain)
   */
  static createEventChain(events: DomainEvent[]): DomainEvent[][] {
    // Сгруппируем события по correlationId и отсортируем по causationId
    const grouped = EventUtils.groupByCorrelationId(events);
    const chains: DomainEvent[][] = [];
    
    for (const [correlationId, correlationEvents] of grouped) {
      // Сортируем события для создания правильной цепочки
      const sortedEvents = [...correlationEvents].sort((a, b) => {
        if (a.causationId && b.causationId) {
          return a.causationId.localeCompare(b.causationId);
        }
        return a.timestamp.getTime() - b.timestamp.getTime();
      });
      
      chains.push(sortedEvents);
    }
    
    return chains;
  }
}