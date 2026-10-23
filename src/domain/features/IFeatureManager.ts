/**
 * Доменный контракт менеджера feature-флагов.
 * Layer: Domain
 *
 * Не зависит от конкретного способа хранения, кеша или метрик.
 */
import type {
  FeatureFlags,
  FeatureFlagMetadata,
  MigrationStatus,
} from '../../core/config/feature-flags';
import type { FeatureContext } from './FeatureContext';

export interface IFeatureManager {
  /**
   * Инициализировать менеджер (загрузка конфигурации, warmup и т.п.).
   * Может безопасно вызываться многократно.
   */
  initialize(): Promise<void>;

  /**
   * Проверить, включён ли флаг для переданного контекста.
   *
   * flagKey:
   * - ключ из FeatureFlags для статически известных флагов;
   * - строка для потенциально динамических/экспериментальных флагов.
   */
  isEnabled(
    flagKey: keyof FeatureFlags | string,
    context?: FeatureContext,
  ): Promise<boolean>;

  /**
   * Получить снимок всех флагов.
   */
  getAllFlags(): Promise<FeatureFlags>;

  /**
   * Установить булево значение флага.
   */
  setFlag(flagKey: keyof FeatureFlags, value: boolean): Promise<void>;

  /**
   * Получить метаданные конкретного флага.
   */
  getFlagMetadata(
    flagKey: keyof FeatureFlags,
  ): FeatureFlagMetadata | undefined;

  /**
   * Получить метаданные всех флагов.
   */
  getAllMetadata(): Promise<Record<keyof FeatureFlags, FeatureFlagMetadata>>;

  /**
   * Получить агрегированный статус миграции инфраструктурных и прикладных флагов.
   */
  getMigrationStatus(): Promise<MigrationStatus>;
}