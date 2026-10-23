import type { IFeatureManager } from '@domain/features/IFeatureManager';
import type { FeatureContext } from '@domain/features/FeatureContext';
import type {
  FeatureFlags,
  FeatureFlagMetadata,
  MigrationStatus,
} from '@domain/features/FeatureFlagsConfig';
import type { ICache } from '@domain/cache/ICache';

export interface CachedFeatureManagerConfig {
  inner: IFeatureManager;
  cache: ICache;

  flagsCacheKey?: string;
  migrationStatusCacheKey?: string;

  namespace?: string;
}

export class CachedFeatureManager implements IFeatureManager {
  private readonly inner: IFeatureManager;

  private readonly cache: ICache;

  private readonly flagsCacheKey: string;

  private readonly migrationStatusCacheKey: string;

  private readonly namespace: string;

  private enableCaching: boolean = true;

  constructor(config: CachedFeatureManagerConfig) {
    this.inner = config.inner;
    this.cache = config.cache;
    this.namespace = config.namespace ?? '';
    const baseFlagsKey = config.flagsCacheKey ?? 'feature_flags';
    const baseMigrationStatusKey =
      config.migrationStatusCacheKey ?? 'feature_flags:migration_status';
    this.flagsCacheKey = this.namespace + baseFlagsKey;
    this.migrationStatusCacheKey = this.namespace + baseMigrationStatusKey;
  }

  async initialize(): Promise<void> {
    await this.inner.initialize();

    const flags = await this.inner.getAllFlags();
    this.enableCaching =
      typeof flags.enableCaching === 'boolean' ? flags.enableCaching : true;
  }

  async isEnabled(
    flagKey: keyof FeatureFlags | string,
    context?: FeatureContext,
  ): Promise<boolean> {
    return this.inner.isEnabled(flagKey, context);
  }

  async getAllFlags(): Promise<FeatureFlags> {
    if (this.enableCaching !== true) {
      return this.inner.getAllFlags();
    }

    try {
      const cached = await this.cache.get<FeatureFlags>(this.flagsCacheKey);
      if (cached && typeof cached === 'object') {
        return cached;
      }
    } catch {
      // Ошибки кэша не должны влиять на бизнес-логику.
    }

    const flags = await this.inner.getAllFlags();

    try {
      await this.cache.set<FeatureFlags>(this.flagsCacheKey, flags);
    } catch {
      // Ошибки кэша игнорируются.
    }

    return flags;
  }

  async setFlag(flagKey: keyof FeatureFlags, value: boolean): Promise<void> {
    await this.inner.setFlag(flagKey, value);

    try {
      await this.cache.delete(this.flagsCacheKey);
    } catch {
      // Инвалидация кэша best-effort.
    }

    try {
      await this.cache.delete(this.migrationStatusCacheKey);
    } catch {
      // Инвалидация кэша best-effort.
    }

    const flags = await this.inner.getAllFlags();
    this.enableCaching =
      typeof flags.enableCaching === 'boolean' ? flags.enableCaching : true;
  }

  getFlagMetadata(flagKey: keyof FeatureFlags): FeatureFlagMetadata | undefined {
    return this.inner.getFlagMetadata(flagKey);
  }

  async getAllMetadata(): Promise<Record<keyof FeatureFlags, FeatureFlagMetadata>> {
    return this.inner.getAllMetadata();
  }

  async getMigrationStatus(): Promise<MigrationStatus> {
    if (this.enableCaching !== true) {
      return this.inner.getMigrationStatus();
    }

    try {
      const cached = await this.cache.get<MigrationStatus>(
        this.migrationStatusCacheKey,
      );
      if (cached && typeof cached === 'object') {
        return cached;
      }
    } catch {
      // Ошибки кэша не должны влиять на бизнес-логику.
    }

    const status = await this.inner.getMigrationStatus();

    try {
      await this.cache.set<MigrationStatus>(
        this.migrationStatusCacheKey,
        status,
      );
    } catch {
      // Ошибки кэша игнорируются.
    }

    return status;
  }
}