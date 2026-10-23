import type { CircuitBreakerKey } from './CircuitBreakerKey';
import type { CircuitBreakerConfig } from './CircuitBreakerConfig';

/**
 * Policy/provider abstraction for circuit breaker configuration overrides.
 *
 * Layer: Core/Resilience.
 *
 * Responsibilities:
 * - expose profile-/policy-oriented overrides based on CircuitBreakerKey attributes
 *   (channel/serviceName/operation/environment/tenantId);
 * - act as single hook point for static per-service/per-operation profiles,
 *   tenant/scenario-specific policies and external PolicyEngine integration;
 * - stay agnostic of runtime overrides stored in ICircuitBreakerRegistry
 *   (setConfigOverride/inline overrides).
 *
 * Implementations SHOULD be pure and side-effect free from the registry
 * perspective; side effects (metrics, logging) belong to infra layers.
 */
export interface ICircuitBreakerPolicyProvider {
  /**
   * Return a policy-/profile-driven configuration override for the given key.
   *
   * Sources MAY include:
   * - static configs (per-channel / per-service / per-operation / per-environment);
   * - PolicyEngine / external policy services;
   * - tenant/scenario-specific rules.
   *
   * Implementations MUST NOT apply runtime overrides; those are handled by
   * ICircuitBreakerRegistry (stored overrides + inline configOverride argument).
   *
   * Key attributes typically used for policy decisions:
   * - channel;
   * - serviceName;
   * - operation;
   * - environment;
   * - tenantId (when available).
   */
  getConfigOverride(
    key: CircuitBreakerKey,
  ): Partial<CircuitBreakerConfig> | null | undefined;
}

/**
 * Default no-op implementation of ICircuitBreakerPolicyProvider.
 *
 * Used when no static profiles / PolicyEngine integration is configured.
 * Always returns undefined so that effective config falls back to:
 * DEFAULT_CIRCUIT_BREAKER_CONFIG + runtime overrides.
 */
export class NoopCircuitBreakerPolicyProvider
  implements ICircuitBreakerPolicyProvider
{
  /**
   * Always returns undefined to signal "no policy override" for this key.
   */
  getConfigOverride(
    _key: CircuitBreakerKey,
  ): Partial<CircuitBreakerConfig> | undefined {
    return undefined;
  }
}