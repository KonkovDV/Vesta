import type { DualReadComparisonResult, DualReadOperation } from './dual_read_types';
import { recordDualReadCheckMetrics, type DualReadMetricOutcome } from '../observability/memory-dual-read-metrics';

/**
 * Adapter between DualReadComparisonResult and dual-read Prometheus metrics.
 *
 * Layer: Memory (observability adapter)
 *
 * This module is intentionally thin: it knows about the shape of
 * DualReadComparisonResult and delegates actual metric recording to
 * memory-dual-read-metrics.ts, which in turn uses the monitoring facade.
 */

export function classifyDualReadOutcome(
  result: DualReadComparisonResult,
): DualReadMetricOutcome {
  if (result.ok) {
    return 'ok';
  }

  if (result.errorMessage) {
    return 'shadow_error';
  }

  return 'mismatch';
}

/**
 * Record dual-read metrics for a completed comparison result.
 *
 * Metrics are recorded in a best-effort manner and must never affect the
 * main dual-read flow or request handling.
 */
export function recordDualReadResultMetrics(result: DualReadComparisonResult): void {
  try {
    const outcome = classifyDualReadOutcome(result);

    recordDualReadCheckMetrics({
      operation: result.context.operation as DualReadOperation,
      outcome,
      mismatchedCount: result.diffSummary.mismatchedCount,
    });
  } catch {
    // Metrics must never break dual-read comparison/reporting.
  }
}