import type { IFeatureEvaluationObserver } from '@domain/features/IFeatureEvaluationObserver';
import type { FeatureContext } from '@domain/features/FeatureContext';
import type IMetricsPort from '@domain/metrics/IMetricsPort';
import type { MetricContext } from '@domain/metrics/IBusinessMetrics';
import { getOrCreateCounter, getOrCreateGauge } from '../../monitoring';

export interface MetricsFeatureEvaluationObserverConfig {
  metricsPort?: IMetricsPort;
  perFlagMetricsEnabled?: boolean;
  perFlagMetricsAllowlist?: Set<string>;
}

const featureFlagsReadCounter = getOrCreateCounter(
  'feature_flags_read_total',
  'Total successful feature flag read operations',
  ['source'],
);

const featureFlagChangeCounter = getOrCreateCounter(
  'feature_flag_changes_total',
  'Total number of feature flag changes',
  ['flag', 'from', 'to'],
);

const featureFlagStateGauge = getOrCreateGauge(
  'feature_flag_state',
  'Current state of individual feature flags',
  ['flag', 'value'],
);

export class MetricsFeatureEvaluationObserver
  implements IFeatureEvaluationObserver
{
  private readonly metricsPort?: IMetricsPort;

  private readonly perFlagMetricsEnabled: boolean;

  private readonly perFlagMetricsAllowlist?: Set<string>;

  constructor(config: MetricsFeatureEvaluationObserverConfig = {}) {
    this.metricsPort = config.metricsPort;
    this.perFlagMetricsEnabled = config.perFlagMetricsEnabled ?? true;
    this.perFlagMetricsAllowlist = config.perFlagMetricsAllowlist;
  }

  async onEvaluated(params: {
    flag: string;
    result: boolean;
    context?: FeatureContext;
  }): Promise<void> {
    const { flag, result, context } = params;

    if (!this.metricsPort && this.perFlagMetricsEnabled === false) {
      return;
    }

    if (this.metricsPort) {
      const metricContext = this.buildEvaluateContext(flag, result, context);
      try {
        this.metricsPort.recordSuccess('feature_flags.evaluate', metricContext);
      } catch {
        // Observer must not break feature evaluation flow.
      }
    }

    if (!this.perFlagMetricsEnabled) {
      return;
    }

    try {
      featureFlagsReadCounter.inc({ source: 'manager' });
    } catch {
      // Prometheus errors must be ignored.
    }
  }

  async onChanged(params: {
    flag: string;
    oldValue: boolean;
    newValue: boolean;
  }): Promise<void> {
    const { flag, oldValue, newValue } = params;

    if (this.metricsPort) {
      const metricContext = this.buildChangeContext(flag, oldValue, newValue);
      try {
        this.metricsPort.recordSuccess('feature_flags.change', metricContext);
      } catch {
        // Observer must not break feature manager writes.
      }
    }

    if (!this.shouldEmitPerFlagMetrics(flag)) {
      return;
    }

    try {
      featureFlagChangeCounter.inc({
        flag,
        from: oldValue ? '1' : '0',
        to: newValue ? '1' : '0',
      });

      featureFlagStateGauge.set(
        { flag, value: newValue ? '1' : '0' },
        newValue ? 1 : 0,
      );
    } catch {
      // Prometheus errors must be ignored.
    }
  }

  private shouldEmitPerFlagMetrics(flag: string): boolean {
    if (!this.perFlagMetricsEnabled) {
      return false;
    }
    if (
      this.perFlagMetricsAllowlist &&
      !this.perFlagMetricsAllowlist.has(flag)
    ) {
      return false;
    }
    return true;
  }

  private buildEvaluateContext(
    flag: string,
    result: boolean,
    context?: FeatureContext,
  ): MetricContext {
    const tags: Record<string, string | number | boolean> = {
      feature_flag_operation: 'evaluate',
      flag,
      result: Number(result),
    };

    if (context?.userId) {
      tags.userId = context.userId;
    }
    if (context?.tenantId) {
      tags.tenantId = context.tenantId;
    }
    if (context?.region) {
      tags.region = context.region;
    }
    if (context?.sessionId) {
      tags.sessionId = context.sessionId;
    }

    return {
      entityType: 'feature_flag',
      tags,
      timestamp: new Date(),
    };
  }

  private buildChangeContext(
    flag: string,
    oldValue: boolean,
    newValue: boolean,
  ): MetricContext {
    const tags: Record<string, string | number | boolean> = {
      feature_flag_operation: 'change',
      flag,
      from: Number(oldValue),
      to: Number(newValue),
    };

    return {
      entityType: 'feature_flag',
      tags,
      timestamp: new Date(),
    };
  }
}