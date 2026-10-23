/**
 * IMetricsPort - минимальный порт для доменного слоя метрик (DIP)
 * Layer: Domain
 *
 * Обеспечивает базовые операции для измерения и регистрации метрик
 * без привязки к конкретной реализации (Prometheus, StatsD и т.д.).
 */

import type { MetricContext, ITimer } from './IBusinessMetrics';

export interface IMetricsPort {
  startTimer(operation: string, context?: MetricContext): ITimer;
  recordSuccess(operation: string, context?: MetricContext): void;
  recordError(operation: string, error: unknown, context?: MetricContext): void;
  recordLatency(operation: string, duration: number, unit?: 'ms' | 's' | 'm', context?: MetricContext): void;
}

export default IMetricsPort;