/**
 * NoOpMetricsAdapter - stub metrics adapter that does nothing
 * Layer: Infrastructure (test utilities)
 *
 * Used in test environments to disable metrics collection entirely.
 */

import {
  IBusinessMetrics,
  MetricContext,
  OperationalMetric,
  ITimer,
  ICounter,
  IGauge,
  IHistogram,
} from '../../domain/metrics/IBusinessMetrics';
import type { IMetricsPort } from '../../domain/metrics/IMetricsPort';

class NoOpTimer implements ITimer {
  stop(): void {}
  record(): void {}
}

class NoOpCounter implements ICounter {
  increment(): void {}
  reset(): void {}
}

class NoOpGauge implements IGauge {
  set(): void {}
  increment(): void {}
  decrement(): void {}
}

class NoOpHistogram implements IHistogram {
  observe(): void {}
}

/**
 * No-op metrics adapter for test environments
 */
export class NoOpMetricsAdapter implements IBusinessMetrics, IMetricsPort {
  increment(_operation?: string, _context?: MetricContext): void {}
  gauge(_operation?: string, _value?: number, _context?: MetricContext): void {}
  histogram(_metric: OperationalMetric, _value: number, _buckets?: number[], _context?: MetricContext): void {}
  timer(_metric: OperationalMetric, _duration: number, _unit?: 'ms' | 's' | 'm', _context?: MetricContext): void {}
  event(_eventName?: string, _context?: MetricContext): void {}
  recordSuccess(_operation?: string, _context?: MetricContext): void {}
  recordError(_operation?: string, _error?: unknown, _context?: MetricContext): void {}
  recordBusinessEvent(_eventType: string, _properties: Record<string, unknown>, _context?: MetricContext): void {}
  recordLatency(_operation: string, _duration: number, _unit?: 'ms' | 's' | 'm', _context?: MetricContext): void {}
  recordUserActivity(_activity?: string, _userId?: string, _context?: MetricContext): void {}
  recordPerformance(_component: string, _metric: string, _value: number, _unit?: string, _context?: MetricContext): void {}
  recordQuality(_service: string, _qualityMetric: string, _value: number, _target?: number, _context?: MetricContext): void {}
  
  startTimer(_operation?: string, _context?: MetricContext): ITimer {
    return new NoOpTimer();
  }
  
  createCounter(_name?: string, _context?: MetricContext): ICounter {
    return new NoOpCounter();
  }
  
  createGauge(_name?: string, _context?: MetricContext): IGauge {
    return new NoOpGauge();
  }
  
  createHistogram(_metric: OperationalMetric, _buckets?: number[], _context?: MetricContext): IHistogram {
    return new NoOpHistogram();
  }
  
  exportMetrics(): string {
    return '';
  }
  
  cleanup(): void {}
  stop(): void {}
}
