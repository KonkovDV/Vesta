/**
 * Реестр стратегий feature-флагов.
 * Layer: Domain
 *
 * Хранит набор IFeatureStrategy и предоставляет метод выбора подходящей
 * стратегии на основе метаданных флага.
 * Не зависит от DI и инфраструктуры.
 */
import type { FeatureFlagMetadata } from '../../../core/config/feature-flags';
import type { IFeatureStrategy } from './IFeatureStrategy';

export class FeatureStrategyRegistry {
  private readonly strategies: IFeatureStrategy[];
  private readonly defaultStrategy: IFeatureStrategy;

  constructor(strategies: IFeatureStrategy[] = []) {
    this.strategies = [...strategies];
    this.defaultStrategy = {
      supports: () => true,
      isEnabled: ({ value }) => value,
    };
  }

  /**
   * Зарегистрировать дополнительную стратегию.
   * Порядок регистрации важен: используется первый подходящий обработчик.
   */
  register(strategy: IFeatureStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * Найти стратегию, поддерживающую переданные метаданные.
   * Если ничего не нашлось, возвращается простая булевая стратегия,
   * которая просто возвращает value без модификаций.
   */
  resolveStrategy(metadata: FeatureFlagMetadata): IFeatureStrategy {
    for (const strategy of this.strategies) {
      if (strategy.supports(metadata)) {
        return strategy;
      }
    }

    return this.defaultStrategy;
  }
}