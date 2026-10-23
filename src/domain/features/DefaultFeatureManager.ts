/**
 * Доменная реализация менеджера feature-флагов.
 * Layer: Domain
 *
 * Инкапсулирует in-memory состояние флагов и метаданных и работает
 * поверх абстрактного IFeatureFlagsStore и реестра стратегий.
 */
import type {
  FeatureFlags,
  FeatureFlagMetadata,
  MigrationStatus,
} from '../../core/config/feature-flags';
import type { FeatureContext } from './FeatureContext';
import type { IFeatureManager } from './IFeatureManager';
import type { IFeatureEvaluationObserver } from './IFeatureEvaluationObserver';
import { NullFeatureEvaluationObserver } from './NullFeatureEvaluationObserver';
import type { IFeatureFlagsStore } from '../feature-flags/IFeatureFlagsStore';
import { FeatureStrategyRegistry } from './strategies/FeatureStrategyRegistry';
import {
  findDependencyCycle,
  validateMetadataConsistency,
} from './FeatureFlagMetadataValidator';

export interface DefaultFeatureManagerConfig {
  store: IFeatureFlagsStore;
  strategyRegistry: FeatureStrategyRegistry;
  observer?: IFeatureEvaluationObserver;
  defaultFlags: FeatureFlags;
  metadata: Record<keyof FeatureFlags, FeatureFlagMetadata>;
}

export class DefaultFeatureManager implements IFeatureManager {
  private readonly store: IFeatureFlagsStore;

  private readonly strategyRegistry: FeatureStrategyRegistry;

  private readonly observer: IFeatureEvaluationObserver;

  private readonly defaultFlags: FeatureFlags;
  private readonly baseMetadata: Record<keyof FeatureFlags, FeatureFlagMetadata>;

  private flags: FeatureFlags;
  private metadata: Record<keyof FeatureFlags, FeatureFlagMetadata>;

  private initialized = false;
  private initPromise?: Promise<void>;

  private readonly lock = new Map<keyof FeatureFlags, Promise<void>>();

  constructor(config: DefaultFeatureManagerConfig) {
    this.store = config.store;
    this.strategyRegistry = config.strategyRegistry;
    this.observer = config.observer ?? new NullFeatureEvaluationObserver();
    this.defaultFlags = { ...config.defaultFlags };
    this.baseMetadata = { ...config.metadata };

    this.flags = { ...this.defaultFlags };
    this.metadata = { ...this.baseMetadata };

    // Базовая проверка консистентности метаданных на этапе конфигурации.
    validateMetadataConsistency(this.flags, this.metadata);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const loaded = await this.loadFlagsFromStore();
      this.flags = { ...loaded };

      // Метаданные считаем статичными и не загружаем из store.
      validateMetadataConsistency(this.flags, this.metadata);

      this.initialized = true;
    })();

    return this.initPromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async loadFlagsFromStore(): Promise<FeatureFlags> {
    try {
      const stored = await this.store.loadFlags();
      if (stored && Object.keys(stored).length > 0) {
        return { ...this.defaultFlags, ...stored };
      }
      return { ...this.defaultFlags };
    } catch {
      return { ...this.defaultFlags };
    }
  }

  private isKnownFlagKey(flagKey: string): flagKey is keyof FeatureFlags {
    return Object.prototype.hasOwnProperty.call(this.flags, flagKey);
  }

  private normalizeFlagKey(
    flagKey: keyof FeatureFlags | string,
  ): keyof FeatureFlags | null {
    if (typeof flagKey === 'string') {
      return this.isKnownFlagKey(flagKey) ? (flagKey) : null;
    }

    return flagKey;
  }

  async isEnabled(
    flagKey: keyof FeatureFlags | string,
    context?: FeatureContext,
  ): Promise<boolean> {
    await this.ensureInitialized();

    const normalizedKey = this.normalizeFlagKey(flagKey);
    if (!normalizedKey) {
      return false;
    }

    const value = this.flags[normalizedKey];
    const metadata = this.metadata[normalizedKey];

    if (!metadata) {
      return value;
    }

    const strategy = this.strategyRegistry.resolveStrategy(metadata);
    const result = strategy.isEnabled({
      flagKey: String(normalizedKey),
      value,
      metadata,
      context,
    });

    try {
      await this.observer.onEvaluated({
        flag: String(normalizedKey),
        result,
        context,
      });
    } catch {
      // Наблюдатель не должен ломать доменную логику.
    }

    return result;
  }

  async getAllFlags(): Promise<FeatureFlags> {
    await this.ensureInitialized();
    return { ...this.flags };
  }

  getFlagMetadata(
    flagKey: keyof FeatureFlags,
  ): FeatureFlagMetadata | undefined {
    return this.metadata[flagKey];
  }

  async getAllMetadata(): Promise<Record<keyof FeatureFlags, FeatureFlagMetadata>> {
    // Метаданные статичны, инициализация не обязательна.
    return { ...this.metadata };
  }

  async setFlag(flagKey: keyof FeatureFlags, value: boolean): Promise<void> {
    await this.ensureInitialized();

    // Ждём завершения предыдущей операции для этого флага.
    while (this.lock.has(flagKey)) {
      const existing = this.lock.get(flagKey);
      if (!existing) {
        break;
      }
       
      await existing;
    }

    let releaseLock: () => void = () => undefined;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = () => resolve();
    });
    this.lock.set(flagKey, lockPromise);

    try {
      const metadata = this.metadata[flagKey];

      if (metadata) {
        if (value) {
          // Мягкая детекция циклических зависимостей.
          const cycle = findDependencyCycle(flagKey, this.metadata);
          if (cycle) {
            // На доменном уровне только детектируем; реакция остаётся на вышележащих слоях.
          }
        }

        for (const dep of metadata.requires) {
          const depKey = this.normalizeFlagKey(dep);
          if (!depKey) {
            continue;
          }

          if (value && !this.flags[depKey]) {
            throw new Error(`Cannot enable ${String(flagKey)} without ${dep}`);
          }
        }
      }

      const oldValue = this.flags[flagKey];
      this.flags[flagKey] = value;

      await this.store.saveFlags({ ...this.flags });

      if (this.observer.onChanged && oldValue !== value) {
        try {
          await this.observer.onChanged({
            flag: String(flagKey),
            oldValue,
            newValue: value,
          });
        } catch {
          // Наблюдатель не должен ломать доменную логику.
        }
      }
    } finally {
      releaseLock();
      this.lock.delete(flagKey);
    }
  }

  async getMigrationStatus(): Promise<MigrationStatus> {
    await this.ensureInitialized();

    const enabled = (key: keyof FeatureFlags): boolean => this.flags[key];

    const infrastructure: MigrationStatus['infrastructure'] = {
      eventStore: {
        stub: { status: 'healthy' },
        real: { status: enabled('useRealEventStore') ? 'healthy' : 'unknown' },
        migrated: enabled('useRealEventStore'),
      },
      eventBus: {
        stub: { status: 'healthy' },
        real: { status: enabled('useRealEventBus') ? 'healthy' : 'unknown' },
        migrated: enabled('useRealEventBus'),
      },
      outbox: {
        stub: { status: 'healthy' },
        real: { status: enabled('useRealOutbox') ? 'healthy' : 'unknown' },
        migrated: enabled('useRealOutbox'),
      },
      database: {
        stub: { status: 'healthy' },
        real: { status: enabled('useRealDatabase') ? 'healthy' : 'unknown' },
        migrated: enabled('useRealDatabase'),
      },
    };

    const application: MigrationStatus['application'] = {
      authService: {
        stub: { status: 'healthy' },
        real: { status: enabled('useRealAuthService') ? 'healthy' : 'unknown' },
        migrated: enabled('useRealAuthService'),
      },
      rateLimit: {
        stub: { status: 'healthy' },
        real: { status: enabled('useRealRateLimit') ? 'healthy' : 'unknown' },
        migrated: enabled('useRealRateLimit'),
      },
    };

    return {
      infrastructure,
      application,
    };
  }
}
