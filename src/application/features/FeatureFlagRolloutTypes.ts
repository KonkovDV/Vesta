/**
 * Feature Flag Rollout Types
 * Layer: Application (features)
 *
 * Shared types for feature flag rollout operations.
 * Extracted from FeatureFlagsService.ts to break circular dependency with
 * FeatureFlagsRolloutOrchestrator.ts (TASK-023).
 */

import type { FeatureFlags } from '../../core/config/feature-flags';

/**
 * Стандартизированные профили rollout'а для feature flags.
 *
 * - 'infra' — инфраструктурный стек (event store, event bus, outbox, database);
 * - 'application' — прикладной стек (auth, rate limit, event-sourcing, CQRS);
 * - 'full' — объединённый сценарий 'infra' + 'application'.
 */
export type FeatureFlagsRolloutProfile = 'infra' | 'application' | 'full';

/**
 * Описывает один шаг rollout-профиля для отдельного флага.
 */
export interface FeatureFlagRolloutStep {
  /**
   * Имя фич-флага.
   */
  flag: keyof FeatureFlags;
  /**
   * Фактические шаги раскатки процента трафика для флага.
   * Эти значения передаются в rolloutFlag; если они не заданы в metadata,
   * используется [100].
   */
  percentages: number[];
}

/**
 * Результат выполнения rollout-профиля.
 */
export interface FeatureFlagsRolloutResult {
  /**
   * Имя rollout-профиля, который был запущен.
   */
  profile: FeatureFlagsRolloutProfile;
  /**
   * Полный список шагов профиля, включая фактические percentages.
   */
  steps: FeatureFlagRolloutStep[];
  /**
   * Список флагов, успешно раскатанных без ошибок.
   */
  succeeded: Array<{ flag: keyof FeatureFlags }>;
  /**
   * Список флагов, для которых rollout завершился с ошибкой.
   * Оркестратор не делает глобальный rollback и не бросает исключение,
   * а возвращает информацию об ошибке.
   */
  failed: Array<{ flag: keyof FeatureFlags; error: string }>;
}
