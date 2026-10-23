import type { ICircuitBreaker } from '../../domain/external/ICircuitBreaker';
import type { CircuitBreakerKey } from './CircuitBreakerKey';
import type { CircuitBreakerConfig } from './CircuitBreakerConfig';

/**
 * Registry for circuit breakers.
 *
 * Layer: Core/Resilience.
 *
 * Responsibilities:
 * - keep a shared ICircuitBreaker instance per CircuitBreakerKey;
 * - resolve effective configuration profile (defaults + overrides);
 * - provide a single entry point for infrastructure/application layers
 *   to obtain breakers without caring about concrete implementations.
 */
export interface ICircuitBreakerRegistry {
  /**
   * Get (or create) a shared circuit breaker for the given key.
   *
   * If the breaker does not exist yet, the registry MUST:
   * - resolve the effective config (default + any stored overrides);
   * - merge it with the optional configOverride provided by the caller;
   * - create a new ICircuitBreaker via ICircuitBreakerFactory;
   * - store and return the shared instance.
   */
  getBreaker(
    key: CircuitBreakerKey,
    configOverride?: Partial<CircuitBreakerConfig>,
  ): ICircuitBreaker;

  /**
   * Return the effective configuration profile that will be used for the
   * given key (default + overrides).
   */
  getEffectiveConfig(key: CircuitBreakerKey): CircuitBreakerConfig;

  /**
   * Register or update a configuration override for a specific breaker key.
   *
   * Implementations SHOULD merge this override with defaults when computing
   * the effective config.
   */
  setConfigOverride(
    key: CircuitBreakerKey,
    override: Partial<CircuitBreakerConfig>,
  ): void;
}