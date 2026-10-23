/**
 * Feature Flags Types
 * Layer: Core
 * 
 * Типы и интерфейсы для Feature Flags Service.
 * Реализация перемещена в Application layer.
 */

export interface FeatureFlags {
// Infrastructure
useRealEventStore: boolean;
useRealEventBus: boolean;
useRealOutbox: boolean;
useRealDatabase: boolean;

// MAS / Runtime
redisMasSessionDualWrite: boolean;
redisMasSessionReadFromRedisFirst: boolean;

// Application
useRealAuthService: boolean;
useRealRateLimit: boolean;

// Domain
enableEventSourcing: boolean;
enableCQRS: boolean;

// Performance
enableCaching: boolean;
enableMetrics: boolean;

// Agent safety
AGENTS_KILL_SWITCH: boolean;
}

export interface FeatureFlagTimeWindowConfig {
  /**
   * Время начала активации флага (ISO-строка или timestamp).
   */
  startTime?: string;

  /**
   * Время окончания активации флага (ISO-строка или timestamp).
   */
  endTime?: string;
}

/**
 * Конфигурация простого A/B‑теста для булевого флага.
 * controlWeight + treatmentWeight задают относительные веса групп.
 */
export interface FeatureFlagAbTestConfig {
  controlWeight: number;
  treatmentWeight: number;
}

export interface FeatureFlagMetadata {
  description: string;
  defaultValue: boolean;
  /**
   * Жёсткие зависимости от других флагов.
   */
  requires: string[]; // Зависимости от других флагов
  /**
   * Ключевые риски при включении флага.
   */
  risks: string[]; // Риски при включении
  /**
   * Проценты для постепенного включения инфраструктурного флага.
   */
  rolloutSteps: number[]; // Проценты для постепенного включения
  /**
   * Процент аудитории, для которой флаг включён (0–100).
   * Используется в PercentageStrategy.
   */
  rolloutPercentage?: number;
  /**
   * Список регионов, в которых флаг может быть включён.
   * Используется в RegionStrategy; при отсутствии списка стратегия не применяется.
   */
  regions?: string[];
  /**
   * Окно времени, в котором флаг активен.
   * Используется в TimeWindowStrategy.
   */
  timeWindow?: FeatureFlagTimeWindowConfig;
  /**
   * Конфигурация простого A/B‑теста "control/treatment".
   * Используется в AbTestStrategy; при отсутствии — стратегия не применяется.
   */
  abTest?: FeatureFlagAbTestConfig;
}

export interface MigrationStatus {
  infrastructure: {
    eventStore: { stub: ServiceHealth; real: ServiceHealth; migrated: boolean };
    eventBus: { stub: ServiceHealth; real: ServiceHealth; migrated: boolean };
    outbox: { stub: ServiceHealth; real: ServiceHealth; migrated: boolean };
    database: { stub: ServiceHealth; real: ServiceHealth; migrated: boolean };
  };
  application: {
    authService: { stub: ServiceHealth; real: ServiceHealth; migrated: boolean };
    rateLimit: { stub: ServiceHealth; real: ServiceHealth; migrated: boolean };
  };
}

export interface ServiceHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  latency?: number;
  error?: string;
}

/**
 * Feature Flags core exports.
 *
 * Важно:
 * - Не реэкспортировать Application-слой из Core, чтобы не создавать циклы зависимостей.
 * - FeatureFlagsService и фабрика создаются и живут в application/services/FeatureFlagsService.ts.
 * - Core может содержать только типы/константы, не зависящие от application.
 *
 * Если вам нужен FeatureFlagsService:
 * - Импортируйте его из 'src/application/services/FeatureFlagsService'.
 */