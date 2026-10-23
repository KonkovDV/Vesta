/**
 * IConcurrencyLimiter — Domain interface for DI-injectable concurrency limiting.
 *
 * Unlike the core/utils/concurrency-limiter.ts batch utility, this is a stateful
 * DI service that manages a shared semaphore across the application for
 * rate-limiting parallel LLM/tool calls at the service level.
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.3 "Parallelization" — worker pool / concurrency limiting
 */

import type { CorrelationId } from '@/ai-types';

/**
 * A concurrency slot that must be released after use.
 */
export interface ConcurrencySlot {
  readonly slotId: string;
  readonly acquiredAt: number;
  release(): void;
}

/**
 * DI-injectable concurrency limiter service.
 * Lifecycle: singleton.
 */
export interface IConcurrencyLimiter {
  /** Acquire a concurrency slot, waiting if at limit. */
  acquire(
    scope: string,
    correlationId: CorrelationId,
  ): Promise<ConcurrencySlot>;

  /** Execute fn within a concurrency-limited scope. */
  withLimit<T>(
    scope: string,
    fn: () => Promise<T>,
    correlationId: CorrelationId,
  ): Promise<T>;

  /** Current active count for a scope. */
  getActiveCount(scope: string): number;

  /** Maximum concurrency for a scope (default: 10). */
  getMaxConcurrency(scope: string): number;
}
