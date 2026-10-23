/**
 * Event Gap Detector - контракт и DTO для поиска разрывов в Event Store / Outbox
 * Layer: Domain (контракты)
 */

/**
 * Типы gap'ов, поддерживаемые MVP-реализацией gap detector'а.
 */
export type EventGapKind =
  | 'ES_GSN_GAP'
  | 'ES_OUTBOX_MISSING'
  | 'OUTBOX_ORPHAN';

/**
 * Описание конкретного обнаруженного gap'а в Event Store / Outbox.
 */
export interface EventGap {
  kind: EventGapKind;

  // Диапазон GSN, в котором обнаружен gap (опционально для orphan'ов)
  fromGsn?: number;
  toGsn?: number;

  // Контекст события / outbox-записи, если применимо
  eventId?: string;
  aggregateId?: string;
  eventType?: string;

  // Outbox-контекст
  outboxMessageId?: string;
  outboxStatus?: string;

  // Вспомогательные поля для triage (могут быть не заполнены в MVP)
  detectedAt: Date;
  details?: Record<string, unknown>;
}

/**
 * Результат сканирования окна GSN.
 */
export interface EventGapScanResult {
  /** Нижняя граница окна (exclusive), переданная в scanGsnWindow, или null при чтении с начала */
  fromGsn: number | null;
  /** Верхняя граница окна (inclusive), вычисленная по событиям Event Store, или null при пустом окне */
  toGsn: number | null;
  /** Сколько событий было прочитано из event_store.events в рамках вызова */
  totalEventsScanned: number;
  /** Сколько строк было прочитано из outbox.messages в рамках вызова */
  totalOutboxScanned: number;
  /** Найденные gap'ы в указанном окне */
  gaps: EventGap[];
}

/**
 * Интерфейс детектора разрывов (gap detector) поверх Event Store / Outbox.
 */
export interface IEventGapDetector {
  /**
   * Сканирует окно GSN начиная с fromExclusiveGsn (gsn > fromExclusiveGsn, или с начала при null)
   * и возвращает найденные gap'ы в Event Store и Outbox.
   */
  scanGsnWindow(
    fromExclusiveGsn: number | null,
    limit: number,
  ): Promise<EventGapScanResult>;

  /**
   * Возвращает максимальный gsn, известный gap detector'у (обычно это просто MAX(events.gsn)).
   * Может делегировать в IEventStore.getLatestGsn().
   */
  getLatestGsn(): Promise<number | null>;
}