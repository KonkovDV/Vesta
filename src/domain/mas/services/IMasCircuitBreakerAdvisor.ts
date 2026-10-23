import type { CircuitBreakerKey } from '../../../core/resilience/CircuitBreakerKey';
import type {
  CircuitBreakerState,
  CircuitBreakerMetrics,
} from '../../external/ICircuitBreaker';

/**
 * Snapshot of circuit breaker state used by MAS recovery / advisors.
 *
 * Layer: Domain/MAS.
 *
 * This is a read-only projection tailored for MAS circuit-breaker–aware
 * recovery logic; it deliberately exposes only a subset of metrics.
 */
export interface MasCircuitBreakerSnapshot {
  key: CircuitBreakerKey;
  state: CircuitBreakerState;
  metrics: Pick<
    CircuitBreakerMetrics,
    'errorRate' | 'rejectedCalls' | 'failures' | 'timeouts' | 'stateChangedAt'
  >;
  /**
   * Duration in milliseconds the breaker has been in the current state.
   */
  stateDurationMs: number;
}

/**
 * Facade for MAS-aware queries against circuit breaker state.
 *
 * Layer: Domain/MAS.
 *
 * Implementations may use either a distributed state store (e.g. Postgres) or
 * in-memory ICircuitBreakerRegistry as a fallback source of truth.
 */
export interface IMasCircuitBreakerAdvisor {
  /**
   * Obtain a snapshot for the given circuit breaker key at the specified time.
   *
   * Returns null when the breaker/state cannot be found or when the advisor
   * chooses to treat the state as unavailable (e.g. store error).
   */
  getSnapshotForKey(
    key: CircuitBreakerKey,
    now?: Date,
  ): Promise<MasCircuitBreakerSnapshot | null>;
}
