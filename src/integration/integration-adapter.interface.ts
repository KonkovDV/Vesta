/**
 * Базовые контракты адаптеров для Enterprise Integration Hub.
 * Слой: Integration.
 *
 * Минимальный MVP: in-memory реестр адаптеров без внешних вызовов.
 */

export type IntegrationType = 'slack' | 'jira' | 'salesforce' | string;

export type IntegrationHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface IntegrationHealth {
  /** Уникальный идентификатор адаптера в хабе (id). */
  id: string;
  /** Тип интеграции, например 'slack', 'jira', 'salesforce'. */
  type: IntegrationType;
  /** Статус доступности интеграции. */
  status: IntegrationHealthStatus;
  /** Человекочитаемое описание состояния (опционально). */
  message?: string;
  /** ISO‑timestamp проведения health‑check. */
  checkedAt: string;
  /** Дополнительные диагностические поля. */
  details?: Record<string, unknown>;
}

/**
 * Минимальный интерфейс ENT‑адаптера для Integration Hub.
 */
export interface IntegrationAdapter {
  /**
   * Уникальный идентификатор адаптера в рамках хаба.
   * Например: 'slack-default', 'jira-cloud-main'.
   */
  getId(): string;

  /**
   * Тип интеграции (канонический).
   * Например: 'slack', 'jira', 'salesforce'.
   */
  getType(): IntegrationType;

  /**
   * Быстрая проверка доступности интеграции.
   * В MVP‑stub реализация может всегда возвращать true.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Расширенный health‑report интеграции.
   */
  healthCheck(): Promise<IntegrationHealth>;
}