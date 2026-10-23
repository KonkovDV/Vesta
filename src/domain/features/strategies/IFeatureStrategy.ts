/**
 * Базовый интерфейс стратегии оценки feature-флагов.
 * Layer: Domain
 *
 * Стратегии инкапсулируют условия включения фича-флага на основе метаданных
 * и контекста, оставаясь чистыми (без побочных эффектов и зависимостей от инфраструктуры).
 */
import type { FeatureFlagMetadata } from '../../../core/config/feature-flags';
import type { FeatureContext } from '../FeatureContext';

export interface IFeatureStrategy {
  /**
   * Определяет, применима ли стратегия к данному флагу по его метаданным.
   */
  supports(metadata: FeatureFlagMetadata): boolean;

  /**
   * Возвращает итоговое значение флага с учётом контекста и метаданных.
   *
   * value — базовое булево значение флага (после storage/админки),
   * которое стратегия может дополнительно сузить (например, по проценту или региону).
   */
  isEnabled(params: {
    flagKey: string;
    value: boolean;
    metadata: FeatureFlagMetadata;
    context?: FeatureContext;
  }): boolean;
}