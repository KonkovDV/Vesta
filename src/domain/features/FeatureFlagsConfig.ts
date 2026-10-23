/**
 * SSOT-конфигурация feature-флагов.
 * Layer: Domain
 *
 * Чистый модуль данных, зависящий только от core-типов.
 */

import type {
  FeatureFlags,
  FeatureFlagMetadata,
  MigrationStatus,
} from '../../core/config/feature-flags';

// Переэкспорт core-типов, чтобы application-слой мог зависеть от них через Domain, не импортируя @core/* напрямую.
export type {
  FeatureFlags,
  FeatureFlagMetadata,
  MigrationStatus,
} from '../../core/config/feature-flags';

export type FeatureFlagKey = keyof FeatureFlags;
export type FeatureFlagMetadataMap = Record<FeatureFlagKey, FeatureFlagMetadata>;

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  // Infrastructure
  useRealEventStore: false,
  useRealEventBus: false,
  useRealOutbox: false,
  useRealDatabase: false,
  redisMasSessionDualWrite: false,
  redisMasSessionReadFromRedisFirst: false,

  // Application
  useRealAuthService: false,
  useRealRateLimit: false,

  // Domain
  enableEventSourcing: false,
  enableCQRS: false,

  // Performance
  enableCaching: true,
  enableMetrics: true,

  // Agent safety. Off until an operator turns it on.
  AGENTS_KILL_SWITCH: false,
};

export const FEATURE_FLAGS_METADATA: FeatureFlagMetadataMap = {
  useRealEventStore: {
    description: 'Использовать реальный PostgreSQL Event Store вместо in-memory',
    defaultValue: false,
    requires: [],
    risks: ['Потеря данных при неправильной конфигурации', 'Зависимость от PostgreSQL'],
    rolloutSteps: [1, 10, 25, 50, 100],
  },
  useRealEventBus: {
    description: 'Использовать реальный Redis Event Bus вместо in-memory',
    defaultValue: false,
    requires: [],
    risks: ['Потеря сообщений при проблемах с Redis', 'Дополнительная latency'],
    rolloutSteps: [1, 10, 25, 50, 100],
  },
  useRealOutbox: {
    description: 'Использовать PostgreSQL Outbox для надежной доставки событий',
    defaultValue: false,
    requires: ['useRealEventStore', 'useRealEventBus'],
    risks: ['Сложность отката', 'Зависимость от транзакций'],
    rolloutSteps: [5, 15, 30, 60, 100],
  },
  useRealDatabase: {
    description: 'Использовать реальную PostgreSQL БД вместо in-memory',
    defaultValue: false,
    requires: [],
    risks: ['Миграция данных', 'Производительность'],
    rolloutSteps: [1, 10, 25, 50, 100],
  },
  redisMasSessionDualWrite: {
    description:
      'Дублировать запись MAS session state в Redis (dual-write поверх in-memory; R2.1-C1) ',
    defaultValue: false,
    requires: [],
    risks: ['Расхождение источников данных', 'Нагрузка на Redis'],
    rolloutSteps: [1, 10, 25, 50, 100],
  },
  redisMasSessionReadFromRedisFirst: {
    description:
      'Читать MAS session state из Redis в приоритете (требует dual-write; R2.1-C1)',
    defaultValue: false,
    requires: ['redisMasSessionDualWrite'],
    risks: ['Чтение устаревших данных при деградации', 'Зависимость от Redis'],
    rolloutSteps: [1, 10, 25, 50, 100],
  },
  useRealAuthService: {
    description: 'Использовать реальный Auth Service',
    defaultValue: false,
    requires: ['useRealDatabase'],
    risks: ['Проблемы с аутентификацией'],
    rolloutSteps: [10, 30, 60, 100],
  },
  useRealRateLimit: {
    description: 'Использовать реальный Rate Limiting с Redis',
    defaultValue: false,
    requires: ['useRealEventBus'],
    risks: ['Блокировка пользователей'],
    rolloutSteps: [10, 30, 60, 100],
  },
  enableEventSourcing: {
    description: 'Включить Event Sourcing pattern',
    defaultValue: false,
    requires: ['useRealEventStore'],
    risks: ['Увеличение объема данных', 'Сложность отладки'],
    rolloutSteps: [100],
  },
  enableCQRS: {
    description: 'Включить CQRS pattern',
    defaultValue: false,
    requires: ['useRealEventStore', 'enableEventSourcing'],
    risks: ['Сложность синхронизации'],
    rolloutSteps: [100],
  },
  enableCaching: {
    description: 'Включить кэширование',
    defaultValue: true,
    requires: [],
    risks: ['Устаревшие данные в кэше'],
    rolloutSteps: [100],
  },
  enableMetrics: {
    description: 'Включить сбор метрик',
    defaultValue: true,
    requires: [],
    risks: ['Производительность'],
    rolloutSteps: [100],
  },
  AGENTS_KILL_SWITCH: {
    description: 'Остановить новые и возобновляемые прогоны агента',
    defaultValue: false,
    requires: [],
    risks: ['Все прогоны агента завершаются без вызова модели'],
    rolloutSteps: [100],
  },
};

export interface FeatureFlagsConfig {
  defaultFlags: FeatureFlags;
  metadata: FeatureFlagMetadataMap;
}

export const FEATURE_FLAGS_CONFIG: FeatureFlagsConfig = {
  defaultFlags: DEFAULT_FEATURE_FLAGS,
  metadata: FEATURE_FLAGS_METADATA,
};
