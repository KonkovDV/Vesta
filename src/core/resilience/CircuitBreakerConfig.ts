/**
 * Core configuration profile for circuit breakers.
 * Layer: Core/Resilience.
 *
 * This config is environment-agnostic and can be sourced from:
 * - static defaults;
 * - per-service / per-operation profiles;
 * - dynamic policy engines (future phases).
 */

export interface CircuitBreakerConfig {
  /**
   * Optional human-readable name for metrics/logging.
   */
  name?: string;

  /**
   * Number of failed calls within the evaluation window required
   * to transition CLOSED → OPEN.
   */
  failureThreshold: number;

  /**
   * Number of successful calls in HALF_OPEN required to transition
   * HALF_OPEN → CLOSED.
   */
  successThreshold: number;

  /**
   * Base duration (in ms) to stay in OPEN before allowing HALF_OPEN probes.
   */
  openStateDurationMs: number;

  /**
   * Maximum number of probe calls in HALF_OPEN before making a decision.
   * After this many attempts, the breaker either:
   * - closes (if successThreshold reached); or
   * - re-opens if failures occur.
   */
  halfOpenProbeCount: number;

  /**
   * Optional sliding window size (number of recent calls) used to evaluate
   * failureThreshold. If omitted, implementation may use total counters or
   * a simple consecutive-failure policy.
   */
  slidingWindowSize?: number;

  /**
   * Additional cooldown after openStateDurationMs before allowing HALF_OPEN probes.
   * Helps avoid flapping for unstable downstream services.
   */
  cooldownMs?: number;

  /**
   * Enable/disable metrics for this breaker instance. When false, infra
   * implementations should avoid touching Prometheus metrics for performance.
   */
  metricsEnabled?: boolean;

  /**
   * Enable/disable emission of CircuitBreakerEvents for this breaker.
   * Actual persistence to EventStore is out of scope for T009 Code phase.
   */
  eventsEnabled?: boolean;

  /**
   * Enable/disable metrics for blocked (short-circuited) calls.
   */
  blockedCallsMetricsEnabled?: boolean;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  openStateDurationMs: 60_000,
  halfOpenProbeCount: 5,
  slidingWindowSize: 50,
  cooldownMs: 0,
  metricsEnabled: true,
  eventsEnabled: true,
  blockedCallsMetricsEnabled: true,
};

/**
 * Merge a base config with a partial override, keeping semantic defaults.
 */
export function mergeCircuitBreakerConfig(
  base: CircuitBreakerConfig,
  override?: Partial<CircuitBreakerConfig>,
): CircuitBreakerConfig {
  if (!override) {
    return { ...base };
  }

  return {
    name: override.name ?? base.name,
    failureThreshold: override.failureThreshold ?? base.failureThreshold,
    successThreshold: override.successThreshold ?? base.successThreshold,
    openStateDurationMs:
      override.openStateDurationMs ?? base.openStateDurationMs,
    halfOpenProbeCount:
      override.halfOpenProbeCount ?? base.halfOpenProbeCount,
    slidingWindowSize:
      override.slidingWindowSize ?? base.slidingWindowSize,
    cooldownMs: override.cooldownMs ?? base.cooldownMs,
    metricsEnabled: override.metricsEnabled ?? base.metricsEnabled,
    eventsEnabled: override.eventsEnabled ?? base.eventsEnabled,
    blockedCallsMetricsEnabled:
      override.blockedCallsMetricsEnabled ?? base.blockedCallsMetricsEnabled,
  };
}