import type { ICircuitBreaker } from '../../domain/external/ICircuitBreaker';
import type { CircuitBreakerKey } from './CircuitBreakerKey';
import type { CircuitBreakerConfig } from './CircuitBreakerConfig';

/**
 * Factory interface for creating ICircuitBreaker instances.
 *
 * Layer: Core/Resilience.
 *
 * Responsibilities:
 * - hide concrete implementation details (infrastructure-specific);
 * - allow DI to inject logger/clock/metrics into breaker implementations;
 * - be used exclusively via ICircuitBreakerRegistry in most call sites.
 */
export interface ICircuitBreakerFactory {
  /**
   * Create a new circuit breaker instance for the given key and config.
   *
   * The caller (typically a registry) decides whether this instance will be
   * stored as a shared singleton or used in a more granular scope.
   */
  createBreaker(key: CircuitBreakerKey, config: CircuitBreakerConfig): ICircuitBreaker;
}