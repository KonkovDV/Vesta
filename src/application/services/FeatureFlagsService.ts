/**
 * Feature Flags Service
 * Layer: Application
 *
 * Управляет feature flags для постепенной миграции от stub к real сервисам.
 * Поддерживает динамическое включение/выключение функций без перезапуска.
 */

import {
  FeatureFlags,
  FeatureFlagMetadata,
  MigrationStatus,
} from '../../core/config/feature-flags';
import type { ICache } from '../../domain/cache/ICache';
import type IMetricsPort from '../../domain/metrics/IMetricsPort';
import type { MetricContext } from '../../domain/metrics/IBusinessMetrics';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IFeatureFlagsStore } from '../../domain/feature-flags/IFeatureFlagsStore';
import { getOverallHealth, getOrCreateCounter, getOrCreateGauge } from '../../monitoring';
import { getConfig, getRawEnv } from '../../config';
// Default flags configuration
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS_METADATA,
} from '../../domain/features/FeatureFlagsConfig';
import {
  validateMetadataConsistency as validateMetadataConsistencyDomain,
  findDependencyCycle as findDependencyCycleDomain,
} from '../../domain/features/FeatureFlagMetadataValidator';
import type { IFeatureManager } from '@domain/features/IFeatureManager';
import type { FeatureContext } from '@domain/features/FeatureContext';
import { FeatureFlagsRolloutOrchestrator } from '../features/FeatureFlagsRolloutOrchestrator';

// Default flags configuration
export const DEFAULT_FLAGS: FeatureFlags = DEFAULT_FEATURE_FLAGS;

export interface FeatureFlagsServiceConfig {
  /**
   * Кэш/быстрое хранилище флагов (обычно Redis), резолвится из DI как 'ICache'.
   * Не является единственным источником правды — используется как акселератор поверх store.
   */
  redis?: ICache;
  /**
   * Персистентное хранилище конфигурации feature flags (канонический интерфейс).
   * Резолвится из DI как 'IFeatureFlagsStore'.
   */
  store?: IFeatureFlagsStore;
  /**
   * Порт метрик (Prometheus-адаптер и т.п.), резолвится как 'IMetricsPort'.
   */
  metrics?: IMetricsPort;
  /**
   * Логгер, совместимый с core ILogger, резолвится как 'ILogger'.
   */
  logger?: ILogger;
  /**
   * Опциональный доменный менеджер фич.
   * При наличии может использоваться как источник истины для флагов/метаданных,
   * сохраняя публичный API сервиса.
   */
  featureManager?: IFeatureManager;
}

// Rollout types imported from shared module to break circular dependency (TASK-023)
import type {
  FeatureFlagsRolloutProfile,
  FeatureFlagRolloutStep,
  FeatureFlagsRolloutResult,
} from '../features/FeatureFlagRolloutTypes';
export type { FeatureFlagsRolloutProfile, FeatureFlagRolloutStep, FeatureFlagsRolloutResult };

const FEATURE_FLAGS_CACHE_KEY = 'feature_flags';

const featureFlagsReadCounter = getOrCreateCounter(
  'feature_flags_read_total',
  'Total successful feature flag read operations',
  ['source']
);

const featureFlagsWriteCounter = getOrCreateCounter(
  'feature_flags_write_total',
  'Total successful feature flag write operations',
  ['target']
);

const featureFlagsErrorCounter = getOrCreateCounter(
  'feature_flags_error_total',
  'Total feature flag load/persist errors',
  ['operation', 'source']
);

const featureFlagsActiveGauge = getOrCreateGauge(
  'feature_flags_active_total',
  'Number of active (enabled) feature flags'
);

const featureFlagStateGauge = getOrCreateGauge(
  'feature_flag_state',
  'Current state of individual feature flags',
  ['flag', 'value']
);

const featureFlagChangeCounter = getOrCreateCounter(
  'feature_flag_changes_total',
  'Total number of feature flag changes',
  ['flag', 'from', 'to']
);

const featureFlagRollbackCounter = getOrCreateCounter(
  'feature_flag_rollback_total',
  'Total number of feature flag rollbacks',
  ['flag']
);

export class FeatureFlagsService {
  private flags: FeatureFlags;
  private metadata: Record<keyof FeatureFlags, FeatureFlagMetadata>;
  private changeCallbacks: Array<(flag: keyof FeatureFlags, value: boolean) => void> = [];
  private lock: Map<keyof FeatureFlags, Promise<void>> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private readonly redis?: ICache;
  private readonly store?: IFeatureFlagsStore;
  private readonly metrics?: IMetricsPort;
  private readonly logger?: ILogger;
  private readonly featureManager?: IFeatureManager;

  private rolloutOrchestrator?: FeatureFlagsRolloutOrchestrator;

  private readonly perFlagMetricsEnabled: boolean;
  private readonly perFlagMetricsAllowlist: Set<string> | null;

  constructor(config: FeatureFlagsServiceConfig = {}) {
    this.redis = config.redis;
    this.store = config.store;
    this.metrics = config.metrics;
    this.logger = config.logger;
    this.featureManager = config.featureManager;

    const appConfig = getConfig();
    const envValue = appConfig.FF_PER_FLAG_METRICS_ENABLED;
    this.perFlagMetricsEnabled =
      envValue === undefined ? true : envValue.toLowerCase() !== 'false';

    const allowlistRaw = appConfig.FF_PER_FLAG_METRICS_ALLOWLIST;
    if (allowlistRaw && allowlistRaw.trim().length > 0) {
      const items = allowlistRaw
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      this.perFlagMetricsAllowlist = items.length > 0 ? new Set(items) : null;
    } else {
      this.perFlagMetricsAllowlist = null;
    }

    // Инициализируем с дефолтными значениями
    this.flags = { ...DEFAULT_FLAGS };
    this.metadata = this.initializeMetadata();
    this.updateActiveFlagsGauge();
  }

  /**
   * Асинхронная инициализация сервиса
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    const metricContext = this.buildMetricContext('initialize');
    const timer = this.metrics?.startTimer('feature_flags.initialize', metricContext);

    this.initPromise = this.loadFlagsAsync()
      .then(flags => {
        this.flags = flags;
        this.initialized = true;
        this.logInfo('Feature flags loaded asynchronously', { source: 'initialize' });
        this.metrics?.recordSuccess('feature_flags.initialize', metricContext);
      })
      .catch(error => {
        this.initialized = true;
        this.logError('Failed to initialize feature flags', error);
        this.metrics?.recordError('feature_flags.initialize', error, metricContext);
      })
      .finally(() => {
        timer?.stop();
      });

    return this.initPromise;
  }

  /**
   * Проверить, инициализирован ли сервис
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Type guard для проверки валидности флага
   */
  private isValidFlag(flag: string): flag is keyof FeatureFlags {
    return typeof flag === 'string' && (flag as keyof FeatureFlags) in this.flags;
  }

  private getEnvOverrideOrNull(flag: keyof FeatureFlags): boolean | null {
    const rawEnv = getRawEnv();
    const envKey = `FF_${String(flag).toUpperCase()}`;
    const envOverride = rawEnv[envKey];

    if (envOverride === undefined) {
      return null;
    }

    return envOverride === 'true';
  }

  /**
   * Возвращает эффективное значение флага с учётом env-override.
   * Используется во внутренних ветках (migration status, dependency checks),
   * где ранее полагались на sync-метод isEnabled().
   */
  private getEffectiveFlagValue(flag: keyof FeatureFlags): boolean {
    const override = this.getEnvOverrideOrNull(flag);
    if (override !== null) {
      return override;
    }
    return this.flags[flag];
  }

  /**
   * Synchronous, context-free feature flag check.
   *
   * Intended primarily for bootstrap/DI wiring and legacy call sites.
   * New application code SHOULD prefer isEnabledAsync(...) with FeatureContext.
   */
  isEnabled(flag: keyof FeatureFlags | string): boolean {
    const key =
      typeof flag === 'string' ? (flag as keyof FeatureFlags) : flag;

    if (!this.isValidFlag(String(key))) {
      this.logWarn(`Invalid feature flag: ${String(flag)}`);
      return false;
    }

    return this.getEffectiveFlagValue(key);
  }

  /**
   * Async-API проверки фича-флага с учётом контекста.
   * Делегирует в IFeatureManager при его наличии, иначе использует локальное состояние.
   */
  async isEnabledAsync(
    flag: keyof FeatureFlags,
    context?: FeatureContext,
  ): Promise<boolean> {
    const override = this.getEnvOverrideOrNull(flag);
    if (override !== null) {
      return override;
    }

    if (this.featureManager) {
      return this.featureManager.isEnabled(flag, context);
    }

    // Fallback к локальному snapshot'у без sync-обёртки
    return this.flags[flag];
  }

  /**
   * Async-API для получения полного снимка флагов.
   * Делегирует в IFeatureManager при его наличии, иначе использует локальное состояние.
   */
  async getAllFlagsAsync(): Promise<FeatureFlags> {
    return this.getAllFlagsFromManagerOrLocal();
  }

  /**
   * Async-API для получения всех метаданных фич-флагов.
   * Делегирует в IFeatureManager при его наличии, иначе использует локальное состояние.
   */
  async getAllMetadataAsync(): Promise<
    Record<keyof FeatureFlags, FeatureFlagMetadata>
  > {
    return this.getAllMetadataFromManagerOrLocal();
  }

  /**
   * Безопасно установить флаг с валидацией
   */
  async setFlagSafe(flag: string, value: boolean): Promise<boolean> {
    if (!this.isValidFlag(flag)) {
      this.logWarn(`Invalid feature flag: ${flag}`);
      return false;
    }

    try {
      await this.setFlag(flag, value);
      return true;
    } catch (error) {
      this.logError(`Failed to set flag ${flag}`, error);
      return false;
    }
  }

  /**
   * Установить значение флага с защитой от race conditions и проверкой циклических зависимостей
   */
  async setFlag(flag: keyof FeatureFlags, value: boolean): Promise<void> {
    // Ждем завершения предыдущей операции с этим флагом
    while (this.lock.has(flag)) {
      await this.lock.get(flag);
    }

    // Создаем lock для этого флага
    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.lock.set(flag, lockPromise);

    const metricContext = this.buildMetricContext('set_flag', { flag: String(flag) });
    const timer = this.metrics?.startTimer('feature_flags.set_flag', metricContext);

    try {
      await this.setFlagThroughManagerOrLocal(flag, value);

      this.metrics?.recordSuccess('feature_flags.set_flag', metricContext);
    } catch (error) {
      this.metrics?.recordError('feature_flags.set_flag', error, metricContext);
      throw error;
    } finally {
      timer?.stop();
      // Освобождаем lock
      releaseLock();
      this.lock.delete(flag);
    }
  }

  private async setFlagThroughManagerOrLocal(
    flag: keyof FeatureFlags,
    value: boolean,
  ): Promise<void> {
    if (!this.featureManager) {
      const metadata = this.metadata[flag];
      if (metadata) {
        // 1) Мягкая детекция циклических зависимостей
        //    Не ломаем выполнение, только логируем для архитектурного аудита.
        if (value) {
          const cycle = this.findDependencyCycle(flag);
          if (cycle) {
            this.logWarn(
              `[FeatureFlags] Potential circular dependency detected for ${String(
                flag
              )}: ${cycle.join(' -> ')}`,
            );
          }
        }

        // 2) Жёсткая проверка прямых зависимостей: если включаем флаг,
        //    все requires должны быть уже включены (или включатся отдельно).
        for (const dep of metadata.requires) {
          if (
            value &&
            !this.getEffectiveFlagValue(dep as keyof FeatureFlags)
          ) {
            throw new Error(`Cannot enable ${flag} without ${dep}`);
          }
        }
      }

      const oldValue = this.flags[flag];
      this.flags[flag] = value;

      // Сохраняем в persistent storage
      await this.persistFlags();

      // Логируем изменение
      this.logFlagChange(flag, oldValue, value);

      // Вызываем callbacks
      for (const callback of this.changeCallbacks) {
        try {
          callback(flag, value);
        } catch (error) {
          this.logError(`Error in feature flag callback for ${String(flag)}`, error);
        }
      }

      return;
    }

    const oldValue = this.flags[flag];

    await this.featureManager.setFlag(flag, value);

    const newFlags = await this.getAllFlagsFromManagerOrLocal();
    const newValue = newFlags[flag];

    if (oldValue !== newValue) {
      this.logFlagChange(flag, oldValue, newValue);
    }

    this.updateActiveFlagsGauge();

    for (const callback of this.changeCallbacks) {
      try {
        callback(flag, newValue);
      } catch (error) {
        this.logError(`Error in feature flag callback for ${String(flag)}`, error);
      }
    }
  }

  /**
   * Поиск цикла в зависимостях.
   *
   * ВАЖНО:
   * - Детектор циклов используется ТОЛЬКО для диагностики архитектуры и логгирования.
   * - Он НЕ должен ломать runtime / стресс‑тесты при конфликтных метаданных.
   * - Если найден цикл — логируем предупреждение и продолжаем, не бросая исключение.
   */
  private findDependencyCycle(
    startFlag: keyof FeatureFlags
  ): Array<keyof FeatureFlags> | null {
    return findDependencyCycleDomain(startFlag, this.metadata);
  }

  /**
   * Постепенное включение флага (rollout)
   */
  async rolloutFlag(flag: keyof FeatureFlags, percentages: number[]): Promise<void> {
    if (this.featureManager) {
      const orchestrator = this.getRolloutOrchestrator();
      return orchestrator.rolloutFlag(flag, percentages);
    }

    const metadataMap = await this.getAllMetadataFromManagerOrLocal();
    const metadata = metadataMap[flag];
    if (!metadata) {
      throw new Error(`No metadata for flag ${String(flag)}`);
    }

    for (const percentage of percentages) {
      const rawEnv = getRawEnv();
      const envKey = `FF_${String(flag).toUpperCase()}_ROLLOUT`;

      rawEnv[envKey] = String(percentage);

      this.logInfo(`Rolling out ${String(flag)} to ${percentage}%`, {
        flag: String(flag),
        percentage,
      });

      await this.waitForStabilization(flag, percentage);

      const metrics = await this.checkRolloutMetrics(flag);
      if (!metrics.isHealthy) {
        const errorMessage = `Rollout failed for ${String(flag)} at ${percentage}%`;
        this.logError(errorMessage, new Error(metrics.errors.join(', ')), {
          flag: String(flag),
          percentage,
          errors: metrics.errors,
        });
        await this.setFlag(flag, false);
        throw new Error(`Rollout failed: ${metrics.errors.join(', ')}`);
      }
    }

    await this.setFlag(flag, true);

    const rawEnv = getRawEnv();
    const envKey = `FF_${String(flag).toUpperCase()}_ROLLOUT`;
    delete rawEnv[envKey];
  }

  /**
   * Откат флага
   */
  async rollbackFlag(flag: keyof FeatureFlags, reason: string): Promise<void> {
    if (this.featureManager) {
      const orchestrator = this.getRolloutOrchestrator();
      return orchestrator.rollbackFlag(flag, reason);
    }

    this.logWarn(`Rolling back ${String(flag)}: ${reason}`);
    await this.setFlag(flag, false);

    // Логируем откат
    this.logRollback(flag, reason);
  }

  /**
   * Добавить callback на изменение флага
   */
  onFlagChange(callback: (flag: keyof FeatureFlags, value: boolean) => void): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Async-API для получения статуса миграции.
   * Делегирует в IFeatureManager при его наличии, иначе использует локальное состояние флагов и env-override.
   */
  async getMigrationStatusAsync(): Promise<MigrationStatus> {
    return this.getMigrationStatusFromManagerOrLocal();
  }

  private async getAllFlagsFromManagerOrLocal(): Promise<FeatureFlags> {
    if (this.featureManager) {
      const flagsFromManager = await this.featureManager.getAllFlags();

      // Обновляем локальный snapshot для метрик; источник истины остаётся у доменного менеджера.
      this.flags = { ...flagsFromManager };

      return flagsFromManager;
    }

    // Defensive: ensure flags are initialized (in case of AOP proxy issues)
    if (!this.flags || Object.keys(this.flags).length === 0) {
      this.flags = { ...DEFAULT_FLAGS };
    }

    return { ...this.flags };
  }

  private async getAllMetadataFromManagerOrLocal(): Promise<
    Record<keyof FeatureFlags, FeatureFlagMetadata>
  > {
    if (this.featureManager) {
      return this.featureManager.getAllMetadata();
    }

    return { ...this.metadata };
  }

  private async getMigrationStatusFromManagerOrLocal(): Promise<MigrationStatus> {
    if (this.featureManager) {
      return this.featureManager.getMigrationStatus();
    }

    return {
      infrastructure: {
        eventStore: {
          stub: { status: 'healthy' },
          real: {
            status: this.getEffectiveFlagValue('useRealEventStore')
              ? 'healthy'
              : 'unknown',
          },
          migrated: this.getEffectiveFlagValue('useRealEventStore'),
        },
        eventBus: {
          stub: { status: 'healthy' },
          real: {
            status: this.getEffectiveFlagValue('useRealEventBus')
              ? 'healthy'
              : 'unknown',
          },
          migrated: this.getEffectiveFlagValue('useRealEventBus'),
        },
        outbox: {
          stub: { status: 'healthy' },
          real: {
            status: this.getEffectiveFlagValue('useRealOutbox')
              ? 'healthy'
              : 'unknown',
          },
          migrated: this.getEffectiveFlagValue('useRealOutbox'),
        },
        database: {
          stub: { status: 'healthy' },
          real: {
            status: this.getEffectiveFlagValue('useRealDatabase')
              ? 'healthy'
              : 'unknown',
          },
          migrated: this.getEffectiveFlagValue('useRealDatabase'),
        },
      },
      application: {
        authService: {
          stub: { status: 'healthy' },
          real: {
            status: this.getEffectiveFlagValue('useRealAuthService')
              ? 'healthy'
              : 'unknown',
          },
          migrated: this.getEffectiveFlagValue('useRealAuthService'),
        },
        rateLimit: {
          stub: { status: 'healthy' },
          real: {
            status: this.getEffectiveFlagValue('useRealRateLimit')
              ? 'healthy'
              : 'unknown',
          },
          migrated: this.getEffectiveFlagValue('useRealRateLimit'),
        },
      },
    };
  }

  /**
   * Массовое обновление флагов из partial‑обновления.
   *
   * Используется HTTP‑эндпоинтом [/api/admin/feature-flags] для применения
   * изменений, пришедших от BFF/админки. Оборачивает вызовы setFlag(..)
   * с сохранением всех текущих инвариантов и метрик.
   */
  async updateFlags(updates: Partial<FeatureFlags>): Promise<void> {
    const entries = Object.entries(updates) as [
      keyof FeatureFlags,
      boolean | undefined
    ][];

    for (const [flag, value] of entries) {
      if (typeof value !== 'boolean') {
        continue;
      }

      await this.setFlag(flag, value);
    }
  }

  /**
   * Bulk‑обновление флагов для admin‑API.
   *
   * Возвращает списки успешно применённых и упавших флагов, чтобы HTTP‑слой
   * мог отобразить частичный успех без выбрасывания исключений.
   */
  async bulkUpdateFlags(
    updates: Record<string, boolean>,
  ): Promise<{ applied: string[]; failed: Array<{ flag: string; error: string }> }> {
    const applied: string[] = [];
    const failed: Array<{ flag: string; error: string }> = [];

    for (const [rawFlag, value] of Object.entries(updates)) {
      if (typeof value !== 'boolean') {
        failed.push({ flag: rawFlag, error: 'value_must_be_boolean' });
        continue;
      }

      if (!this.isValidFlag(rawFlag)) {
        failed.push({ flag: rawFlag, error: 'unknown_flag' });
        continue;
      }

      const flag = rawFlag;
      try {
        await this.setFlag(flag, value);
        applied.push(rawFlag);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ flag: rawFlag, error: message });
      }
    }

    return { applied, failed };
  }

  /**
   * Получить метаданные флага
   */
  getFlagMetadata(flag: keyof FeatureFlags): FeatureFlagMetadata | undefined {
    if (this.featureManager) {
      return this.featureManager.getFlagMetadata(flag);
    }
    return this.metadata[flag];
  }

/**
 * Проверка консистентности словаря метаданных с текущим набором фич‑флагов.
 *
 * Возвращает списки несоответствий, которые используются в unit‑тестах governance‑слоя.
 * В non‑production окружениях логирует предупреждение, а в production — ошибку,
 * но не бросает исключения, чтобы не ломать runtime.
 */
validateMetadataConsistency(): {
  missingInMetadata: string[];
  extraInMetadata: string[];
} {
  const { missingInMetadata, extraInMetadata } = validateMetadataConsistencyDomain(
    this.flags,
    this.metadata,
  );

  if (missingInMetadata.length === 0 && extraInMetadata.length === 0) {
    return { missingInMetadata, extraInMetadata };
  }

  const env = getConfig().NODE_ENV ?? 'development';
  const meta: Record<string, unknown> = {
    env,
    missingInMetadata,
    extraInMetadata,
  };

  const message = '[FeatureFlags] Metadata consistency check failed';

  if (env === 'production') {
    this.logError(message, new Error('Feature flag metadata is inconsistent'), meta);
  } else {
    this.logWarn(message, meta);
  }

  return { missingInMetadata, extraInMetadata };
}


  /**
   * Асинхронная загрузка флагов из persistent storage
   */
  private async loadFlagsAsync(): Promise<FeatureFlags> {
    const metricContext = this.buildMetricContext('load_flags');
    const timer = this.metrics?.startTimer('feature_flags.load_flags', metricContext);

    try {
      // Попытка загрузки из кэша
      if (this.redis) {
        try {
          const cached = await this.redis.get<FeatureFlags>(FEATURE_FLAGS_CACHE_KEY);
          if (cached) {
            this.logInfo('Feature flags loaded from cache', { source: 'cache' });
            this.metrics?.recordSuccess(
              'feature_flags.load_flags.cache',
              this.buildMetricContext('load_flags', { source: 'cache' })
            );
            return { ...DEFAULT_FLAGS, ...cached };
          }
        } catch (error) {
          this.logWarn('Failed to load flags from cache', { error: this.safeError(error) });
          this.metrics?.recordError(
            'feature_flags.load_flags.cache',
            error,
            this.buildMetricContext('load_flags', { source: 'cache' })
          );
        }
      }

      // Попытка загрузки через IFeatureFlagsStore (канонический источник при наличии)
      if (this.store) {
        try {
          const stored = await this.store.loadFlags();

          if (stored && Object.keys(stored).length > 0) {
            this.logInfo('Feature flags loaded from store', { source: 'store' });
            this.metrics?.recordSuccess(
              'feature_flags.load_flags.store',
              this.buildMetricContext('load_flags', { source: 'store' })
            );

            // Счётчик успешных чтений через store
            try {
              featureFlagsReadCounter.inc({ source: 'store' });
            } catch {
              // Игнорируем ошибки метрик, чтобы не ломать runtime
            }

            // Обновляем кэш в фоне, если он доступен
            if (this.redis) {
              void this.redis
                .set<FeatureFlags>(FEATURE_FLAGS_CACHE_KEY, { ...DEFAULT_FLAGS, ...stored })
                .catch(error => {
                  this.logWarn('Failed to refresh feature flags cache after store load', {
                    error: this.safeError(error),
                  });
                });
            }

            return { ...DEFAULT_FLAGS, ...stored };
          }

          // Store доступен, но записи ещё нет — используем дефолты.
          this.logInfo('Using default feature flags configuration (store empty)', {
            source: 'store',
          });
          this.metrics?.recordSuccess(
            'feature_flags.load_flags.store',
            this.buildMetricContext('load_flags', { source: 'store', store_empty: true })
          );
          return { ...DEFAULT_FLAGS };
        } catch (error) {
          // Ошибка store не должна ломать инициализацию — fallback к дефолтам.
          this.logWarn('Failed to load flags from store', { error: this.safeError(error) });
          this.metrics?.recordError(
            'feature_flags.load_flags.store',
            error,
            this.buildMetricContext('load_flags', { source: 'store' })
          );
          try {
            featureFlagsErrorCounter.inc({ operation: 'load_flags', source: 'store' });
          } catch {
            // Игнорируем ошибки метрик, чтобы не ломать runtime.
          }
        }
      }


      this.logInfo('Using default feature flags configuration', { source: 'defaults' });
      this.metrics?.recordSuccess(
        'feature_flags.load_flags.defaults',
        this.buildMetricContext('load_flags', { source: 'defaults' })
      );
      return { ...DEFAULT_FLAGS };
    } finally {
      timer?.stop();
    }
  }


  /**
   * Сохранение флагов в persistent storage
   *
   * Приоритет каналов:
   * 1) Кэш (best-effort, не критичен для корректности)
   * 2) IFeatureFlagsStore (основной источник правды при наличии)
   */
  private async persistFlags(): Promise<void> {
    const metricContext = this.buildMetricContext('persist_flags');
    const timer = this.metrics?.startTimer('feature_flags.persist_flags', metricContext);
    const flagsToPersist: FeatureFlags = { ...this.flags };

    try {
      // Сохранение в кэш (не критично для корректности)
      if (this.redis) {
        try {
          await this.redis.set<FeatureFlags>(FEATURE_FLAGS_CACHE_KEY, flagsToPersist);
          this.metrics?.recordSuccess(
            'feature_flags.persist_flags.cache',
            this.buildMetricContext('persist_flags', { target: 'cache' })
          );
        } catch (error) {
          this.logWarn('Failed to save flags to cache', { error: this.safeError(error) });
          this.metrics?.recordError(
            'feature_flags.persist_flags.cache',
            error,
            this.buildMetricContext('persist_flags', { target: 'cache' })
          );
          // Загружаться из кэша при сбое мы не будем, поэтому cache — не критичный канал.
        }
      }

      // Сохранение через IFeatureFlagsStore (основной источник правды при наличии)
      if (this.store) {
        try {
          await this.store.saveFlags(flagsToPersist);

          try {
            featureFlagsWriteCounter.inc({ target: 'store' });
          } catch {
            // не ломаем runtime, ошибки метрик игнорируем
          }

          this.metrics?.recordSuccess(
            'feature_flags.persist_flags.store',
            this.buildMetricContext('persist_flags', { target: 'store' })
          );
        } catch (error) {
          this.logError('Failed to save flags via feature flags store', error, {
            target: 'store',
          });
          this.metrics?.recordError(
            'feature_flags.persist_flags.store',
            error,
            this.buildMetricContext('persist_flags', { target: 'store' })
          );
          try {
            featureFlagsErrorCounter.inc({ operation: 'persist_flags', source: 'store' });
          } catch {
            // метрики не должны ломать бизнес‑логику
          }
          // Хранилище фич-флагов считается основным каналом — ошибка критична.
          throw error;
        }
      }

      // Обновляем агрегированную метрику после успешной записи
      this.updateActiveFlagsGauge();
      this.metrics?.recordSuccess('feature_flags.persist_flags', metricContext);
    } finally {
      timer?.stop();
    }
  }

  /**
   * Инициализация метаданных
   */
  private initializeMetadata(): Record<keyof FeatureFlags, FeatureFlagMetadata> {
    // Возвращаем копию SSOT-карты, чтобы не мутировать исходную конфигурацию.
    return { ...FEATURE_FLAGS_METADATA };
  }

  private shouldEmitPerFlagMetrics(flag: keyof FeatureFlags): boolean {
    if (!this.perFlagMetricsEnabled) {
      return false;
    }
    if (this.perFlagMetricsAllowlist && !this.perFlagMetricsAllowlist.has(String(flag))) {
      return false;
    }
    return true;
  }

  /**
   * Логирование изменения флага
   */
  private logFlagChange(flag: keyof FeatureFlags, oldValue: boolean, newValue: boolean): void {
    const meta = {
      flag: String(flag),
      oldValue,
      newValue,
    };

    this.logInfo(`Feature flag ${String(flag)} changed: ${oldValue} → ${newValue}`, meta);

    // Метрика для изменения флага (business-metrics порт)
    if (this.isBusinessMetricsEnabled() && this.metrics) {
      const ctx = this.buildMetricContext('change', {
        flag: String(flag),
        from: Number(oldValue),
        to: Number(newValue),
      });
      this.metrics.recordSuccess('feature_flags.change', ctx);
    }

    // Per-flag Prometheus-метрики (не должны ломать бизнес-логику)
    try {
      if (!this.shouldEmitPerFlagMetrics(flag)) {
        return;
      }

      featureFlagChangeCounter.inc({
        flag: String(flag),
        from: Number(oldValue).toString(),
        to: Number(newValue).toString(),
      });

      featureFlagStateGauge.set(
        { flag: String(flag), value: newValue ? '1' : '0' },
        newValue ? 1 : 0
      );
    } catch {
      // Метрики не должны ломать бизнес-логику
    }
  }

  /**
   * Логирование отката
   */
  private logRollback(flag: keyof FeatureFlags, reason: string): void {
    const meta = {
      flag: String(flag),
      reason,
    };

    this.logWarn(`Feature flag ${String(flag)} rolled back: ${reason}`, meta);

    // Метрика отката (business-metrics порт)
    if (this.isBusinessMetricsEnabled() && this.metrics) {
      const ctx = this.buildMetricContext('rollback', {
        flag: String(flag),
      });
      this.metrics.recordError('feature_flags.rollback', new Error(reason), ctx);
    }

    // Per-flag Prometheus-метрики (не должны ломать бизнес-логику)
    try {
      if (!this.shouldEmitPerFlagMetrics(flag)) {
        return;
      }

      featureFlagRollbackCounter.inc({ flag: String(flag) });

      // Rollback всегда приводит флаг в состояние "0"
      featureFlagStateGauge.set(
        { flag: String(flag), value: '0' },
        0
      );
    } catch {
      // Игнорируем ошибки метрик
    }
  }

  /**
   * Обновить gauge количества активных фич-флагов.
   * Метрика не влияет на бизнес-логику и не должна бросать исключения.
   */
  private updateActiveFlagsGauge(): void {
    try {
      const enabledCount = Object.values(this.flags).filter(Boolean).length;
      featureFlagsActiveGauge.set(enabledCount);
    } catch {
      // Игнорируем любые ошибки метрик, чтобы не ломать runtime.
    }
  }

  /**
   * Ожидание стабилизации после изменения флага
   */
  private async waitForStabilization(flag: keyof FeatureFlags, percentage: number): Promise<void> {
    const waitTime = 30000; // 30 секунд
    this.logInfo(`Waiting ${waitTime}ms for stabilization at ${percentage}%`, {
      flag: String(flag),
      percentage,
    });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  /**
   * Проверка метрик/health при rollout
   */
  private async checkRolloutMetrics(flag: keyof FeatureFlags): Promise<{ isHealthy: boolean; errors: string[] }> {
    const errors: string[] = [];
    const metricContext = this.buildMetricContext('rollout_check', { flag: String(flag) });
    const timer = this.metrics?.startTimer('feature_flags.rollout.check_metrics', metricContext);
 
    try {
      const health = await getOverallHealth();
      const components = health.components || {};
 
      const requiredComponents: string[] = [];
 
      switch (flag) {
        case 'useRealEventStore':
        case 'enableEventSourcing':
        case 'enableCQRS':
          requiredComponents.push('event_store');
          break;
        case 'useRealEventBus':
        case 'useRealRateLimit':
          requiredComponents.push('event_bus');
          break;
        case 'useRealOutbox':
          requiredComponents.push('outbox', 'event_store', 'event_bus');
          break;
        case 'useRealDatabase':
        case 'useRealAuthService':
          requiredComponents.push('database');
          break;
        case 'enableCaching':
          requiredComponents.push('cache');
          break;
        default:
          // Для флагов, не зависящих от health-метрик, считаем метрики здоровыми.
          break;
      }
 
      for (const component of requiredComponents) {
        const st = components[component];
        if (!st?.ok) {
          errors.push(`Component '${component}' is not healthy (${st?.error ?? 'unknown'})`);
        }
      }
 
      const isHealthy = errors.length === 0;
 
      if (isHealthy) {
        this.metrics?.recordSuccess('feature_flags.rollout.check_metrics', metricContext);
      } else {
        this.metrics?.recordError(
          'feature_flags.rollout.check_metrics',
          new Error(errors.join('; ')),
          metricContext
        );
      }
 
      return { isHealthy, errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logError('Failed to evaluate rollout metrics', error, { flag: String(flag) });
      this.metrics?.recordError('feature_flags.rollout.check_metrics', error, metricContext);
      return {
        isHealthy: false,
        errors: [`Failed to evaluate rollout metrics: ${message}`],
      };
    } finally {
      timer?.stop();
    }
  }

  /**
   * Упрощённый rollout-оркестратор для стандартных профилей feature flags.
   *
   * Профили:
   * - 'infra' — инфраструктурный стек (event store, event bus, outbox, database).
   * - 'application' — прикладной стек (auth, rate limit, event sourcing, CQRS).
   * - 'full' — комбинация 'infra' + 'application' в одном проходе.
   *
   * Оркестратор последовательно вызывает rolloutFlag для каждого флага профиля,
   * используя rolloutSteps из metadata (если они определены) или [100] по умолчанию.
   * При ошибке rollout одного из флагов:
   * - уже успешно раскатанные флаги не откатываются;
   * - выполнение профиля прекращается (fail-fast);
   * - информация об ошибке возвращается в результате, а не выбрасывается исключением.
   */
  async rolloutProfile(profile: FeatureFlagsRolloutProfile): Promise<FeatureFlagsRolloutResult> {
    if (this.featureManager) {
      const orchestrator = this.getRolloutOrchestrator();
      return orchestrator.rolloutProfile(profile);
    }

    const profileFlags = this.getRolloutProfileFlags(profile);
    const metadataMap = await this.getAllMetadataFromManagerOrLocal();
 
    const steps: FeatureFlagRolloutStep[] = [];
    const succeeded: Array<{ flag: keyof FeatureFlags }> = [];
    const failed: Array<{ flag: keyof FeatureFlags; error: string }> = [];
 
    this.logInfo(`Starting feature flags rollout profile '${profile}'`, {
      profile,
      flags: profileFlags.map(flag => String(flag)),
    });
 
    for (const flag of profileFlags) {
      const metadata = metadataMap[flag];
      const percentages =
        metadata && Array.isArray(metadata.rolloutSteps) && metadata.rolloutSteps.length > 0
          ? metadata.rolloutSteps
          : [100];
 
      steps.push({ flag, percentages });
 
      try {
        await this.rolloutFlag(flag, percentages);
        succeeded.push({ flag });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ flag, error: message });
 
        this.logError(
          `Feature flags rollout profile '${profile}' failed at flag ${String(flag)}`,
          error,
          {
            profile,
            flag: String(flag),
            percentages,
          }
        );
 
        break;
      }
    }
 
    if (failed.length === 0) {
      this.logInfo(`Completed feature flags rollout profile '${profile}'`, {
        profile,
        flags: succeeded.map(item => String(item.flag)),
      });
    }
 
    return {
      profile,
      steps,
      succeeded,
      failed,
    };
  }

  /**
   * Определяет упорядоченный набор флагов для стандартных rollout-профилей.
   *
   * Порядок в профилях подобран так, чтобы:
   * - сначала включать инфраструктурные зависимости (event store, event bus, outbox, database);
   * - затем прикладные флаги, опирающиеся на инфраструктуру (auth, rate limit, event sourcing, CQRS).
   */
  private getRolloutProfileFlags(profile: FeatureFlagsRolloutProfile): Array<keyof FeatureFlags> {
    const infraProfile: Array<keyof FeatureFlags> = [
      'useRealEventStore',
      'useRealEventBus',
      'useRealOutbox',
      'useRealDatabase',
    ];

    const applicationProfile: Array<keyof FeatureFlags> = [
      'useRealAuthService',
      'useRealRateLimit',
      'enableEventSourcing',
      'enableCQRS',
    ];

    switch (profile) {
      case 'infra':
        return infraProfile;
      case 'application':
        return applicationProfile;
      case 'full':
        return [...infraProfile, ...applicationProfile];
      default:
        // Типизация ограничивает множество профилей, поэтому сюда попасть нельзя.
        return [];
    }
  }

  private getRolloutOrchestrator(): FeatureFlagsRolloutOrchestrator {
    if (!this.rolloutOrchestrator) {
      if (!this.featureManager) {
        throw new Error(
          'FeatureFlagsRolloutOrchestrator requires featureManager; legacy path should not call it.',
        );
      }

      this.rolloutOrchestrator = new FeatureFlagsRolloutOrchestrator(
        this.featureManager,
        this.logger,
        this.metrics,
        (flag, value) => this.setFlag(flag, value),
        (flag, reason) => this.logRollback(flag, reason),
      );
    }

    return this.rolloutOrchestrator;
  }

  /**
   * В Application-слое FeatureFlagsService не зависит напрямую от RequestContext.
   * Контекст запроса (correlation_id и т.п.) может быть добавлен самим ILogger
   * или внешними middleware. Здесь возвращаем undefined, чтобы не тянуть
   * RequestContext в unit-тесты feature-flags и не усиливать связность.
   */
  private getRequestLoggingContext(): Record<string, unknown> | undefined {
    return undefined;
  }

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    const baseMeta = this.getRequestLoggingContext();
    const mergedMeta = { ...baseMeta, ...meta };
    if (!this.logger) {
      return;
    }
    if (typeof this.logger.info === 'function') {
      this.logger.info(message, mergedMeta);
    } else {
      this.logger.log(message, mergedMeta);
    }
  }

  private logWarn(message: string, meta?: Record<string, unknown>): void {
    const baseMeta = this.getRequestLoggingContext();
    const mergedMeta = { ...baseMeta, ...meta };
    if (!this.logger) {
      return;
    }
    this.logger.warn(message, mergedMeta);
  }

  private logError(message: string, error: unknown, meta?: Record<string, unknown>): void {
    const baseMeta = this.getRequestLoggingContext();
    const mergedMeta = { ...baseMeta, ...meta, error: this.safeError(error) };
    if (!this.logger) {
      return;
    }
    this.logger.error(message, mergedMeta);
  }

  private safeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
  }

  private buildMetricContext(
    operation: string,
    extraTags: Record<string, string | number | boolean> = {}
  ): MetricContext {
    return {
      entityType: 'feature_flag',
      tags: {
        feature_flag_operation: operation,
        ...extraTags,
      },
      timestamp: new Date(),
    };
  }

  private isBusinessMetricsEnabled(): boolean {
    const config = getConfig();
    const raw = config.FF_METRICS_ENABLED;
    if (raw === undefined) {
      return true;
    }
    return raw !== 'false';
  }
}

// Factory для создания сервиса
export function createFeatureFlagsService(config: FeatureFlagsServiceConfig = {}): FeatureFlagsService {
  /**
   * Единая точка создания FeatureFlagsService.
   * Вся логика чтения окружения и значений по умолчанию сосредоточена внутри конструктора.
   * NEW CODE:
   * - Не дублировать чтение env-флагов в других местах.
   * - Не создавать FeatureFlagsService вручную; использовать только эту фабрику или DI.
   */
  return new FeatureFlagsService(config);
}