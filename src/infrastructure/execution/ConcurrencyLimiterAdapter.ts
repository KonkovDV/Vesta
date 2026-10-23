/**
 * ConcurrencyLimiterAdapter — Infrastructure adapter for IConcurrencyLimiter.
 *
 * Implements a per-scope semaphore for rate-limiting parallel LLM/tool calls.
 * Each scope has an independent concurrency limit (default: 10).
 *
 * Unlike core/utils/concurrency-limiter.ts (batch utility function),
 * this is a stateful DI-injectable service sharing state across the application.
 *
 * Best Practices Applied (March 2026):
 * - correlationId in all log entries (Hard Rule #6)
 * - Automatic slot release in withLimit via try/finally
 * - IdGenerator-style slot IDs via counter (no crypto in hot path)
 *
 * DI: constructor(logger) — 1 arg
 *
 * @layer Infrastructure (implements Domain port)
 * @see IConcurrencyLimiter (src/domain/execution/concurrency-limiter.interface.ts)
 * @see Book Ch.3 "Parallelization" — worker pool / concurrency limiting
 */

import type {
  IConcurrencyLimiter,
  ConcurrencySlot,
} from '../../domain/execution/concurrency-limiter.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

const DEFAULT_MAX_CONCURRENCY = 10;

interface ScopeState {
  active: number;
  maxConcurrency: number;
  waitQueue: Array<() => void>;
}

export class ConcurrencyLimiterAdapter implements IConcurrencyLimiter {
  private readonly scopes = new Map<string, ScopeState>();
  private slotCounter = 0;

  constructor(
    private readonly logger: ILogger,
  ) {}

  async acquire(
    scope: string,
    correlationId: CorrelationId,
  ): Promise<ConcurrencySlot> {
    const state = this.getOrCreateScope(scope);

    if (state.active >= state.maxConcurrency) {
      this.logger.debug('Concurrency limit reached, waiting', {
        correlationId,
        scope,
        active: state.active,
        maxConcurrency: state.maxConcurrency,
      });

      await new Promise<void>((resolve) => {
        state.waitQueue.push(resolve);
      });
    }

    state.active++;
    const slotId = `slot-${++this.slotCounter}`;

    let released = false;
    const slot: ConcurrencySlot = {
      slotId,
      acquiredAt: Date.now(),
      release: () => {
        if (released) return;
        released = true;
        state.active--;

        const next = state.waitQueue.shift();
        if (next) next();
      },
    };

    return slot;
  }

  async withLimit<T>(
    scope: string,
    fn: () => Promise<T>,
    correlationId: CorrelationId,
  ): Promise<T> {
    const slot = await this.acquire(scope, correlationId);
    try {
      return await fn();
    } finally {
      slot.release();
    }
  }

  getActiveCount(scope: string): number {
    return this.scopes.get(scope)?.active ?? 0;
  }

  getMaxConcurrency(scope: string): number {
    return this.scopes.get(scope)?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private getOrCreateScope(scope: string): ScopeState {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { active: 0, maxConcurrency: DEFAULT_MAX_CONCURRENCY, waitQueue: [] };
      this.scopes.set(scope, state);
    }
    return state;
  }
}
