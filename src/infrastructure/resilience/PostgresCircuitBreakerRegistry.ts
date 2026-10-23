import type {
  ICircuitBreaker,
  CircuitBreakerMetrics,
  CircuitBreakerState,
  CircuitBreakerEventHandler,
} from '../../domain/external/ICircuitBreaker';
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
import type {
  ICircuitBreakerStateStore,
  CircuitBreakerPersistentState,
} from '../../core/resilience/ICircuitBreakerStateStore';

/**
 * Postgres-backed implementation of ICircuitBreakerRegistry.
 *
 * Responsibilities:
 * - keep shared ICircuitBreaker instances per CircuitBreakerKey;
 * - resolve effective configuration (default + policy + persisted + overrides);
 * - delegate actual creation to ICircuitBreakerFactory.
 *
 * NOTE:
 * - Interaction with ICircuitBreakerStateStore is best-effort and asynchronous;
 *   registry methods remain synchronous per ICircuitBreakerRegistry contract.
 * - Persisted config snapshot is loaded lazily and affects subsequent
 *   getEffectiveConfig/getBreaker calls but does not retroactively reconfigure
 *   already created breakers.
 */
export class PostgresCircuitBreakerRegistry
  implements ICircuitBreakerRegistry
{
  private readonly breakers = new Map<string, ICircuitBreaker>();
  private readonly overrides = new Map<string, Partial<CircuitBreakerConfig>>();
  private readonly policyOverrides = new Map<
    string,
    Partial<CircuitBreakerConfig> | undefined
  >();
  private readonly persistedConfigs = new Map<
    string,
    Partial<CircuitBreakerConfig>
  >();
  private readonly loadingKeys = new Set<string>();

  private readonly persistedStates = new Map<string, CircuitBreakerPersistentState>();

  constructor(
    private readonly factory: ICircuitBreakerFactory,
    private readonly policyProvider: ICircuitBreakerPolicyProvider,
    private readonly stateStore: ICircuitBreakerStateStore,
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

    this.ensurePersistentConfigLoaded(key, mapKey);

    const effectiveConfig = this.computeEffectiveConfig(key, configOverride);
    const breaker = this.factory.createBreaker(key, effectiveConfig);
    this.breakers.set(mapKey, breaker);

    this.attachStatePersistenceHandler(mapKey, breaker, key, effectiveConfig);

    if (configOverride) {
      this.mergeOverride(mapKey, configOverride);
    }

    return breaker;
  }

  getEffectiveConfig(key: CircuitBreakerKey): CircuitBreakerConfig {
    const mapKey = serializeCircuitBreakerKey(key);
    this.ensurePersistentConfigLoaded(key, mapKey);
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

    const policyOverride = this.getPolicyOverrideForKey(key, mapKey);
    const storedOverride = this.overrides.get(mapKey);
    const persistedSnapshot = this.persistedConfigs.get(mapKey);

    // default < policy
    let base = mergeCircuitBreakerConfig(this.defaultConfig, policyOverride);

    // Interpret persisted config as "last effective config" snapshot:
    // apply it on top of (default + policy) if present.
    if (persistedSnapshot) {
      base = mergeCircuitBreakerConfig(base, persistedSnapshot);
    }

    // runtime overrides: default/policy/persisted < stored < inline
    const withStored = mergeCircuitBreakerConfig(base, storedOverride);
    return mergeCircuitBreakerConfig(withStored, inlineOverride);
  }

  private getPolicyOverrideForKey(
    key: CircuitBreakerKey,
    mapKey: string,
  ): Partial<CircuitBreakerConfig> | undefined {
    let policyOverride = this.policyOverrides.get(mapKey);
    if (policyOverride === undefined && !this.policyOverrides.has(mapKey)) {
      policyOverride = this.policyProvider.getConfigOverride(key) ?? undefined;
      this.policyOverrides.set(mapKey, policyOverride);
    }
    return policyOverride;
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

  /**
   * Best-effort lazy load of persisted state for a given key.
   *
   * The result is cached in-memory and used as an additional config layer.
   * Errors are swallowed to avoid impacting breaker resolution.
   */
  private ensurePersistentConfigLoaded(
    key: CircuitBreakerKey,
    mapKey: string,
  ): void {
    if (this.persistedConfigs.has(mapKey) || this.loadingKeys.has(mapKey)) {
      return;
    }

    this.loadingKeys.add(mapKey);
    void this.stateStore
      .getState(key)
      .then(async (state) => {
        if (state) {
          this.persistedStates.set(mapKey, state);
          if (state.config) {
            this.persistedConfigs.set(mapKey, state.config);
          }
          return;
        }

        // No existing persisted state: create initial snapshot with CLOSED state
        // and base config (default + policy) so that it can be used as a separate
        // config layer between policy and stored overrides.
        const now = new Date();
        const initialMetrics: CircuitBreakerMetrics = {
          state: 'CLOSED',
          successes: 0,
          failures: 0,
          timeouts: 0,
          errorRate: 0,
          lastFailureAt: undefined,
          lastSuccessAt: undefined,
          rejectedCalls: 0,
          stateChangedAt: now,
          halfOpenToClosed: 0,
          halfOpenToOpen: 0,
        };

        const policyOverride = this.getPolicyOverrideForKey(key, mapKey);
        const baseConfig = mergeCircuitBreakerConfig(
          this.defaultConfig,
          policyOverride,
        );

        const initialState: CircuitBreakerPersistentState = {
          key,
          state: 'CLOSED',
          metrics: initialMetrics,
          config: baseConfig,
          updatedAt: now,
        };

        const created = await this.stateStore.createState(initialState);
        this.persistedStates.set(mapKey, created);
        if (created.config) {
          this.persistedConfigs.set(mapKey, created.config);
        }
      })
      .catch(() => {
        // Swallow errors: registry must remain functional even if store is unavailable.
      })
      .finally(() => {
        this.loadingKeys.delete(mapKey);
      });
  }

  private attachStatePersistenceHandler(
    mapKey: string,
    breaker: ICircuitBreaker,
    key: CircuitBreakerKey,
    effectiveConfig: CircuitBreakerConfig,
  ): void {
    const handler: CircuitBreakerEventHandler = {
      onOpen: (info) => {
        void this.persistSnapshot(
          key,
          mapKey,
          'OPEN',
          info.metrics,
          effectiveConfig,
        );
      },
      onClose: (metrics) => {
        void this.persistSnapshot(
          key,
          mapKey,
          'CLOSED',
          metrics,
          effectiveConfig,
        );
      },
      onHalfOpen: (metrics) => {
        void this.persistSnapshot(
          key,
          mapKey,
          'HALF_OPEN',
          metrics,
          effectiveConfig,
        );
      },
    };

    breaker.addEventHandler(handler);
  }

  private async persistSnapshot(
    key: CircuitBreakerKey,
    mapKey: string,
    state: CircuitBreakerState,
    metrics: CircuitBreakerMetrics,
    effectiveConfig: CircuitBreakerConfig,
  ): Promise<void> {
    try {
      const existing = this.persistedStates.get(mapKey);

      if (!existing) {
        const now = new Date();
        const initial: CircuitBreakerPersistentState = {
          key,
          state,
          metrics,
          config: effectiveConfig,
          updatedAt: now,
        };
        const created = await this.stateStore.createState(initial);
        this.persistedStates.set(mapKey, created);
        if (created.config) {
          this.persistedConfigs.set(mapKey, created.config);
        }
        return;
      }

      const prevUpdatedAt = existing.updatedAt;
      const next: CircuitBreakerPersistentState = {
        key,
        state,
        metrics,
        config: existing.config,
        updatedAt: new Date(),
      };

      const updated = await this.stateStore.tryUpdateState(
        key,
        prevUpdatedAt,
        next,
      );

      if (updated) {
        this.persistedStates.set(mapKey, next);
      } else {
        // Optimistic-lock conflict: another instance already updated the row.
        // Reload latest snapshot for future attempts, but do not fail the caller.
        const latest = await this.stateStore.getState(key);
        if (latest) {
          this.persistedStates.set(mapKey, latest);
          if (latest.config) {
            this.persistedConfigs.set(mapKey, latest.config);
          }
        }
      }
    } catch {
      // Best-effort persistence: never throw from observer path.
    }
  }
}