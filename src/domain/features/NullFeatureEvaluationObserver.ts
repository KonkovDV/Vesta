/**
 * No-op реализация observer'а оценки feature-флагов.
 * Layer: Domain
 *
 * Используется по умолчанию, когда аналитика/метрики не подключены.
 */
import type { IFeatureEvaluationObserver } from './IFeatureEvaluationObserver';

export class NullFeatureEvaluationObserver implements IFeatureEvaluationObserver {
  // намеренно ничего не делает
  async onEvaluated(): Promise<void> {
    // no-op
  }

  async onChanged(): Promise<void> {
    // no-op
  }
}