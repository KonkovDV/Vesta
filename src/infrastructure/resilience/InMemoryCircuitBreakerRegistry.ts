import type { ICircuitBreaker } from '../../domain/external/ICircuitBreaker';
import type { CircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import { serializeCircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import type { CircuitBreakerConfig } from '../../core/resilience/CircuitBreakerConfig';
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  mergeCircuitBreakerConfig,
} from '../../core/resilience/CircuitBreakerConfig';
import type { ICircuitBreakerFactory } from '../../core/resilience/ICircuitBreakerFactory';
import type { ICircuitBreakerRegistry } from '../../core/resilience/ICircuitBreakerRegistry';
import type { ICircuitBreakerPolicyProvider } from '../../core/resilience/ICircuitBreakerPolicyProvider';

/**
 * In-memory implementation of ICircuitBreakerRegistry.
 *
 * Responsibilities:
 * - keep shared ICircuitBreaker instances per CircuitBreakerKey;
 * - resolve effective configuration (default + policy + overrides);
 * - delegate actual creation to ICircuitBreakerFactory.
 */
export class InMemoryCircuitBreakerRegistry implements ICircuitBreakerRegistry {
  private readonly breakers = new Map<string, ICircuitBreaker>();
  private readonly overrides = new Map<string, Partial<CircuitBreakerConfig>>();
  private readonly policyOverrides = new Map<string, Partial<CircuitBreakerConfig> | undefined>();

  constructor(
    private readonly factory: ICircuitBreakerFactory,
    private readonly policyProvider: ICircuitBreakerPolicyProvider,
    private readonly defaultConfig: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
  ) {}

  getBreaker(
    key: CircuitBreakerKey,
    configOverride?: Partial<CircuitBreakerConfig>,
  ): ICircuitBreaker {
    const mapKey = serializeCircuitBreakerKey(key);
    const existing = this.breakers.get(mapKey);
    if (existing) {
      if (configOverride) {
        this.mergeOverride(mapKey, configOverride);
      }
      return existing;
    }

    const effectiveConfig = this.computeEffectiveConfig(key, configOverride);
    const breaker = this.factory.createBreaker(key, effectiveConfig);
    this.breakers.set(mapKey, breaker);

    if (configOverride) {
      this.mergeOverride(mapKey, configOverride);
    }

    return breaker;
  }

  getEffectiveConfig(key: CircuitBreakerKey): CircuitBreakerConfig {
    return this.computeEffectiveConfig(key);
  }

  setConfigOverride(
    key: CircuitBreakerKey,
    override: Partial<CircuitBreakerConfig>,
  ): void {
    const mapKey = serializeCircuitBreakerKey(key);
    this.mergeOverride(mapKey, override);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private computeEffectiveConfig(
    key: CircuitBreakerKey,
    inlineOverride?: Partial<CircuitBreakerConfig>,
  ): CircuitBreakerConfig {
    const mapKey = serializeCircuitBreakerKey(key);

    let policyOverride = this.policyOverrides.get(mapKey);
    if (policyOverride === undefined && !this.policyOverrides.has(mapKey)) {
      policyOverride = this.policyProvider.getConfigOverride(key) ?? undefined;
      this.policyOverrides.set(mapKey, policyOverride);
    }

    const storedOverride = this.overrides.get(mapKey);

    const withPolicy = mergeCircuitBreakerConfig(
      this.defaultConfig,
      policyOverride,
    );
    const withStored = mergeCircuitBreakerConfig(withPolicy, storedOverride);

    return mergeCircuitBreakerConfig(withStored, inlineOverride);
  }

  private mergeOverride(
    mapKey: string,
    override: Partial<CircuitBreakerConfig>,
  ): void {
    const existing = this.overrides.get(mapKey);
    if (existing) {
      this.overrides.set(mapKey, { ...existing, ...override });
    } else {
      this.overrides.set(mapKey, { ...override });
    }
  }
}