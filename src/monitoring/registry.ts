import { Registry, register as globalRegister, Counter, Histogram, Gauge } from 'prom-client';
import { logger } from '../infrastructure/logging/logger';

// Re-export Registry type for consumers that need it
export type { Registry } from 'prom-client';

let registry: Registry = globalRegister;

// Track metric registration failures for meta-monitoring
interface MetricRegistrationFailure {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  error: string;
  timestamp: number;
}

const registrationFailures: MetricRegistrationFailure[] = [];
const MAX_FAILURES_HISTORY = 100;

/**
 * Get recent metric registration failures for health monitoring
 */
export function getRecentRegistrationFailures(): MetricRegistrationFailure[] {
  return [...registrationFailures];
}

/**
 * Get count of metric registration failures
 */
export function getRegistrationFailureCount(): number {
  return registrationFailures.length;
}

function recordRegistrationFailure(name: string, type: 'counter' | 'histogram' | 'gauge', error: unknown): void {
  const failure: MetricRegistrationFailure = {
    name,
    type,
    error: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };

  registrationFailures.push(failure);

  // Keep only recent failures
  if (registrationFailures.length > MAX_FAILURES_HISTORY) {
    registrationFailures.shift();
  }

  logger.error('Failed to register metric', {
    metricName: name,
    metricType: type,
    error: failure.error,
  });
}

// No-op metric type definitions - compatible with prom-client interfaces
// @justified — NoOp vendor type mocks require 'as unknown as' because prom-client
// interfaces have deep internal structures we intentionally don't implement

type NoOpCounterType = Counter<string> & {
  inc(labels?: Record<string, string | number>, value?: number): void;
  inc(value?: number): void;
};

type NoOpHistogramType = Histogram<string> & {
  observe(labels: Record<string, string | number>, value: number): void;
  observe(value: number): void;
  startTimer(labels?: Record<string, string | number>): () => number;
};

type NoOpGaugeType = Gauge<string> & {
  set(labels: Record<string, string | number>, value: number): void;
  set(value: number): void;
};

// No-op implementations that match the methods we actually use
const noOpCounter: NoOpCounterType = {
  inc: (labelsOrValue?: Record<string, string | number> | number, _value?: number): void => {
    // No-op: metric registration failed, silently ignore
  },
  
  get: async () => ({ values: [] } as unknown as Awaited<ReturnType<Counter<string>['get']>>), // @justified
  reset: (): void => {
    // No-op
  },
  labels: (): NoOpCounterType => noOpCounter,
  remove: (): void => {
    // No-op
  },
} as unknown as NoOpCounterType; // @justified

const noOpHistogram: NoOpHistogramType = {
  observe: (labelsOrValue: Record<string, string | number> | number, _value?: number): void => {
    // No-op: metric registration failed, silently ignore
  },
  startTimer: (_labels?: Record<string, string | number>): (() => number) => {
    return () => 0;
  },
  
  get: async () => ({ values: [] } as unknown as Awaited<ReturnType<Histogram<string>['get']>>), // @justified
  reset: (): void => {
    // No-op
  },
  labels: (): NoOpHistogramType => noOpHistogram,
  remove: (): void => {
    // No-op
  },
  zero: (): void => {
    // No-op
  },
} as unknown as NoOpHistogramType; // @justified

const noOpGauge: NoOpGaugeType = {
  set: (labelsOrValue: Record<string, string | number> | number, _value?: number): void => {
    // No-op: metric registration failed, silently ignore
  },
  
  get: async () => ({ values: [] } as unknown as Awaited<ReturnType<Gauge<string>['get']>>), // @justified
  reset: (): void => {
    // No-op
  },
  labels: (): NoOpGaugeType => noOpGauge,
  remove: (): void => {
    // No-op
  },
} as unknown as NoOpGaugeType; // @justified

export function getRegistry(): Registry {
  return registry;
}

export function clearRegistry(): void {
  registry.resetMetrics();
  registrationFailures.length = 0;
}

export function getOrCreateCounter(name: string, help: string, labelNames: string[] = []): Counter<string> {
  try {
    const registryWithMetrics = registry as { getSingleMetric?: (name: string) => Counter<string> | undefined };
    const existing = registryWithMetrics.getSingleMetric?.(name);
    if (existing) return existing;
    return new Counter({ name, help, labelNames, registers: [registry] });
  } catch (error) {
    recordRegistrationFailure(name, 'counter', error);
    return noOpCounter;
  }
}

export function getOrCreateHistogram(name: string, help: string, labelNames: string[] = [], buckets: number[] = []): Histogram<string> {
  try {
    const registryWithMetrics = registry as { getSingleMetric?: (name: string) => Histogram<string> | undefined };
    const existing = registryWithMetrics.getSingleMetric?.(name);
    if (existing) return existing;
    return new Histogram({ name, help, labelNames, buckets: buckets.length ? buckets : [0.01,0.05,0.1,0.25,0.5,1,2,5], registers: [registry] });
  } catch (error) {
    recordRegistrationFailure(name, 'histogram', error);
    return noOpHistogram;
  }
}

export function getOrCreateGauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
  try {
    const registryWithMetrics = registry as { getSingleMetric?: (name: string) => Gauge<string> | undefined };
    const existing = registryWithMetrics.getSingleMetric?.(name);
    if (existing) return existing;
    return new Gauge({ name, help, labelNames, registers: [registry] });
  } catch (error) {
    recordRegistrationFailure(name, 'gauge', error);
    return noOpGauge;
  }
}

export { globalRegister };
