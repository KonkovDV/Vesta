import type {
  IMasCircuitBreakerAdvisor,
  MasCircuitBreakerSnapshot,
} from '../../domain/mas/services/IMasCircuitBreakerAdvisor';
import type {
  ICircuitBreakerStateStore,
} from '../../core/resilience/ICircuitBreakerStateStore';
import type { ICircuitBreakerRegistry } from '../../core/resilience/ICircuitBreakerRegistry';
import type { CircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import type {
  CircuitBreakerState,
  CircuitBreakerMetrics,
} from '../../domain/external/ICircuitBreaker';

/**
 * Infra-level implementation of IMasCircuitBreakerAdvisor.
 *
 * Layer: Infrastructure/MAS.
 *
 * Reads circuit breaker state primarily from a distributed state store
 * (e.g. Postgres), with an optional fallback to the in-memory
 * ICircuitBreakerRegistry when no persisted snapshot is available.
 */
export class MasCircuitBreakerAdvisor implements IMasCircuitBreakerAdvisor {
  constructor(
    private readonly stateStore?: ICircuitBreakerStateStore,
    private readonly registry?: ICircuitBreakerRegistry,
  ) {}

  async getSnapshotForKey(
    key: CircuitBreakerKey,
    now: Date = new Date(),
  ): Promise<MasCircuitBreakerSnapshot | null> {
    const effectiveNow = now;

    // Primary: distributed state store (e.g. Postgres).
    if (this.stateStore) {
      try {
        const state = await this.stateStore.getState(key);
        if (state) {
          return this.toSnapshotFromMetrics(
            key,
            state.state,
            state.metrics,
            effectiveNow,
          );
        }
      } catch {
        // Best-effort: swallow errors and fall back to registry/memory state.
      }
    }

    // Fallback: in-memory registry / local breaker instance.
    if (!this.registry) {
      return null;
    }

    try {
      const breaker = this.registry.getBreaker(key);
      if (!breaker) {
        return null;
      }
      const metrics = breaker.getMetrics();
      const state = breaker.getState();
      return this.toSnapshotFromMetrics(key, state, metrics, effectiveNow);
    } catch {
      return null;
    }
  }

  private toSnapshotFromMetrics(
    key: CircuitBreakerKey,
    state: CircuitBreakerState,
    metrics: CircuitBreakerMetrics,
    now: Date,
  ): MasCircuitBreakerSnapshot {
    const stateChangedAt = metrics.stateChangedAt;
    const stateDurationMs = now.getTime() - stateChangedAt.getTime();

    return {
      key,
      state,
      metrics: {
        errorRate: metrics.errorRate,
        rejectedCalls: metrics.rejectedCalls,
        failures: metrics.failures,
        timeouts: metrics.timeouts,
        stateChangedAt,
      },
      stateDurationMs,
    };
  }
}