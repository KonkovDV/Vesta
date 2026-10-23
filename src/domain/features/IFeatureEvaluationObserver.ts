/**
 * Observer для аналитики и метрик по оценке feature-флагов.
 * Layer: Domain
 *
 * Не содержит зависимостей на инфраструктуру; конкретные реализации
 * могут прокидывать события в метрики/логирование на других слоях.
 */
import type { FeatureContext } from './FeatureContext';

export interface IFeatureEvaluationObserver {
  /**
   * Вызывается при каждой оценке флага.
   */
  onEvaluated(params: {
    flag: string;
    result: boolean;
    context?: FeatureContext;
  }): void | Promise<void>;

  /**
   * Опционально вызывается при изменении значения флага.
   */
  onChanged?(params: {
    flag: string;
    oldValue: boolean;
    newValue: boolean;
  }): void | Promise<void>;
}