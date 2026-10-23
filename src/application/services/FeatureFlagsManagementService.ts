import { FeatureFlags, FeatureFlagMetadata, MigrationStatus } from '../../core/config/feature-flags';
import { FeatureFlagsService } from './FeatureFlagsService';

export interface FeatureFlagsBulkUpdateResult {
  updated: Array<keyof FeatureFlags>;
  failed: Array<{
    flag: keyof FeatureFlags;
    reason: string;
  }>;
  flags: FeatureFlags;
}

export type FeatureFlagsProfileName = 'production' | 'staging' | 'test' | 'custom';

export class FeatureFlagsManagementService {
  constructor(private readonly featureFlagsService: FeatureFlagsService) {}
 
  async getFlags(): Promise<FeatureFlags> {
    return this.featureFlagsService.getAllFlagsAsync();
  }
 
  async getFlag(flag: keyof FeatureFlags): Promise<boolean> {
    return this.featureFlagsService.isEnabledAsync(flag);
  }
 
  getFlagMetadata(flag: keyof FeatureFlags): FeatureFlagMetadata | undefined {
    return this.featureFlagsService.getFlagMetadata(flag);
  }
 
  async getMigrationStatus(): Promise<MigrationStatus> {
    return this.featureFlagsService.getMigrationStatusAsync();
  }
 
  async updateFlagsBulk(patch: Partial<FeatureFlags>): Promise<FeatureFlagsBulkUpdateResult> {
    const patchKeys = Object.keys(patch) as Array<keyof FeatureFlags>;
 
    const currentFlags = await this.featureFlagsService.getAllFlagsAsync();

    if (patchKeys.length === 0) {
      return {
        updated: [],
        failed: [],
        flags: currentFlags,
      };
    }

    const updated: Array<keyof FeatureFlags> = [];
    const failed: Array<{ flag: keyof FeatureFlags; reason: string }> = [];

    for (const key of patchKeys) {
      const nextValue = patch[key];

      if (typeof nextValue !== 'boolean') {
        // Некорректное значение — считаем ошибкой конкретного флага, но не бросаем исключение
        failed.push({
          flag: key,
          reason: 'Invalid value type for feature flag, expected boolean',
        });
        continue;
      }

      if (!(key in currentFlags)) {
        // Защита от некорректного ключа (в случае использования as any)
        failed.push({
          flag: key,
          reason: 'Unknown feature flag',
        });
        continue;
      }

      const currentValue = currentFlags[key];

      // Нет изменений — пропускаем без вызова базового сервиса
      if (currentValue === nextValue) {
        continue;
      }

      const success = await this.featureFlagsService.setFlagSafe(String(key), nextValue);

      if (success) {
        updated.push(key);
        // Обновляем локальное представление флагов, чтобы последующие итерации видели актуальное значение
        currentFlags[key] = nextValue;
      } else {
        failed.push({
          flag: key,
          reason: 'setFlagSafe returned false',
        });
      }
    }

    // Возвращаем актуальное состояние флагов из базового сервиса
    const flags = await this.featureFlagsService.getAllFlagsAsync();

    return {
      updated,
      failed,
      flags,
    };
  }

  /**
   * Установка профиля фич-флагов.
   *
   * ВАЖНО:
   * - На этом шаге профили реализованы консервативно и не добавляют сложной логики.
   * - Базовая реализация просто делегирует в updateFlagsBulk с переданными overrides.
   * - В дальнейшем сюда можно добавить преднастроенные профили (production/staging/test/custom).
   */
  async setProfile(
    profileName: FeatureFlagsProfileName,
    overrides: Partial<FeatureFlags> = {},
  ): Promise<FeatureFlagsBulkUpdateResult> {
    // Профиль пока не влияет на поведение; оставляем точку расширения.
    // Пример дальнейшего развития: маппинг profileName → базовый набор флагов.
    const patch: Partial<FeatureFlags> = {
      ...overrides,
    };

    return this.updateFlagsBulk(patch);
  }
}