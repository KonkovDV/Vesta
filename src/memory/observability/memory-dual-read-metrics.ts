import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';
import type { DualReadOperation } from '../consistency/dual_read_types';

/**
 * Dual-read consistency metrics for Memory Phase 11 (M2.4b).
 *
 * Layer: Memory (observability)
 *
 * Metrics:
 * - Counter:   memory_dualread_checks_total{operation, outcome}
 * - Histogram: memory_dualread_mismatches_per_check{operation, outcome}
 *
 * Where:
 * - operation — logical dual-read operation (e.g. "get_context_window").
 * - outcome   — "ok" | "mismatch" | "shadow_error".
 *
 * As with other memory metrics modules, all public helpers are wrapped in
 * try/catch so that observability issues never impact request handling.
 */
export type DualReadMetricOutcome = 'ok' | 'mismatch' | 'shadow_error';

const dualReadChecksTotal = getOrCreateCounter(
  'memory_dualread_checks_total',
  'Total number of dual-read consistency checks by operation and outcome',
  ['operation', 'outcome'],
);

const dualReadMismatchesPerCheck = getOrCreateHistogram(
  'memory_dualread_mismatches_per_check',
  'Number of mismatches per dual-read check',
  ['operation', 'outcome'],
  // Small bucket set — mismatches per check are expected to be low.
  [0, 1, 2, 5, 10, 20, 50],
);

export function recordDualReadCheckMetrics(params: {
  operation: DualReadOperation;
  outcome: DualReadMetricOutcome;
  mismatchedCount: number;
}): void {
  try {
    dualReadChecksTotal.inc({
      operation: params.operation,
      outcome: params.outcome,
    });

    dualReadMismatchesPerCheck.observe(
      {
        operation: params.operation,
        outcome: params.outcome,
      },
      params.mismatchedCount,
    );
  } catch {
    // Metrics must never break memory consistency logic.
  }
}