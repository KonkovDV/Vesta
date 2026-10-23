import type {
  ICircuitBreaker,
  CircuitBreakerState,
  CircuitBreakerMetrics,
  CircuitBreakerTripInfo,
  CircuitBreakerEventHandler,
  CircuitBreakerResult,
} from '../../domain/external/ICircuitBreaker';
import type { CircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import type {
  CircuitBreakerConfig,
} from '../../core/resilience/CircuitBreakerConfig';
import {
  recordCircuitBreakerState,
  recordCircuitBreakerTrip,
  recordCircuitBreakerBlockedCall,
  recordCircuitBreakerHalfOpenProbe,
} from '../../monitoring/resilience-metrics';
import {
  createCircuitOpenedEvent,
  createCircuitHalfOpenedEvent,
  createCircuitClosedEvent,
  type CircuitBreakerEvent,
} from '../../core/resilience/CircuitBreakerEvents';
import type { CircuitBreakerEventTracingContext } from '../../core/resilience/CircuitBreakerEvents';
import type { ICircuitBreakerFactory } from '../../core/resilience/ICircuitBreakerFactory';
import type { ICircuitBreakerEventObserver } from '../../core/resilience/ICircuitBreakerEventObserver';
import { NoopCircuitBreakerEventObserver } from '../../core/resilience/ICircuitBreakerEventObserver';
import { AsyncLocalRequestContext } from '../../core/context/request-context';

/**
 * Infra-level error used when a call is short-circuited because the breaker is OPEN.
 * Mapped later to MAS/Durable Execution error codes (e.g. CIRCUIT_OPEN).
 */
export class CircuitOpenError extends Error {
  public readonly code = 'CIRCUIT_OPEN';
  public readonly breakerName?: string;
  public readonly breakerKey?: CircuitBreakerKey;
  public readonly resourceName?: string;
  public readonly state?: CircuitBreakerState;

  constructor(
    message: string,
    breakerName?: string,
    breakerKeyOrState?: CircuitBreakerKey | CircuitBreakerState,
  ) {
    super(message);
    this.name = 'CircuitOpenError';
    this.breakerName = breakerName;
    this.resourceName = breakerName;

    if (typeof breakerKeyOrState === 'string') {
      this.state = breakerKeyOrState;
      this.breakerKey = undefined;
    } else {
      this.breakerKey = breakerKeyOrState;
      this.state = undefined;
    }
  }
}

/**
 * Extended Error type for CircuitBreaker timeout detection.
 * Internal use only - not exported.
 */
interface CircuitBreakerTimeoutError extends Error {
  __cbTimeout: true;
}

/**
 * Type guard to check if error is a CircuitBreaker timeout.
 */
function isCircuitBreakerTimeoutError(error: Error): error is CircuitBreakerTimeoutError {
  return (error as CircuitBreakerTimeoutError).__cbTimeout === true;
}

/**
 * Simple async mutex for synchronizing circuit breaker state transitions.
 * Ensures atomic access to shared state in concurrent environments.
 */
class AsyncMutex {
  private promise: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void = () => { /* no-op */ };
    const newPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldPromise = this.promise;
    this.promise = this.promise.then(() => newPromise);
    await oldPromise;
    return release;
  }
}

/**
 * State snapshot for atomic transitions.
 * Captures all mutable state at a point in time.
 */
interface CircuitBreakerStateSnapshot {
  state: CircuitBreakerState;
  metrics: CircuitBreakerMetrics;
  halfOpenProbeAttempts: number;
  recentOutcomes: boolean[];
}

type LegacyCircuitBreakerConfig = {
  failureThreshold: number;
  openTimeoutMs?: number;
  successThreshold?: number;
  halfOpenProbeCount?: number;
  slidingWindowSize?: number;
  cooldownMs?: number;
  metricsEnabled?: boolean;
  eventsEnabled?: boolean;
  blockedCallsMetricsEnabled?: boolean;
  name?: string;
};

function isCircuitBreakerKey(value: string | CircuitBreakerKey): value is CircuitBreakerKey {
  return typeof value !== 'string';
}

function normalizeCircuitBreakerKey(key: string | CircuitBreakerKey): CircuitBreakerKey {
  if (isCircuitBreakerKey(key)) {
    return key;
  }

  return {
    channel: 'OTHER',
    serviceName: key,
    operation: 'execute',
    environment: 'test',
  };
}

function normalizeCircuitBreakerConfig(
  config: CircuitBreakerConfig | LegacyCircuitBreakerConfig,
  legacyName?: string,
): CircuitBreakerConfig {
  const legacyConfig = config as LegacyCircuitBreakerConfig;
  const openStateDurationMs = 'openStateDurationMs' in config
    ? config.openStateDurationMs
    : legacyConfig.openTimeoutMs;

  return {
    failureThreshold: config.failureThreshold,
    successThreshold: config.successThreshold ?? legacyConfig.successThreshold ?? 1,
    openStateDurationMs: openStateDurationMs ?? 60_000,
    halfOpenProbeCount: config.halfOpenProbeCount ?? legacyConfig.halfOpenProbeCount ?? 1,
    slidingWindowSize: config.slidingWindowSize ?? legacyConfig.slidingWindowSize ?? 0,
    cooldownMs: config.cooldownMs ?? legacyConfig.cooldownMs ?? 0,
    metricsEnabled: config.metricsEnabled ?? legacyConfig.metricsEnabled ?? true,
    eventsEnabled: config.eventsEnabled ?? legacyConfig.eventsEnabled ?? true,
    blockedCallsMetricsEnabled:
      config.blockedCallsMetricsEnabled ?? legacyConfig.blockedCallsMetricsEnabled ?? true,
    name: config.name ?? legacyConfig.name ?? legacyName,
  };
}

/**
 * In-memory implementation of ICircuitBreaker with thread-safe state transitions.
 *
 * Responsibilities:
 * - Maintain CLOSED → OPEN → HALF_OPEN → CLOSED state machine;
 * - Track metrics per ICircuitBreaker contract;
 * - Integrate with monitoring/resilience-metrics for Prometheus;
 * - Support event handlers (onOpen/onClose/onHalfOpen/...);
 * - Guarantee atomic state transitions under concurrent access.
 *
 * Thread Safety:
 * - All state mutations are protected by an async mutex;
 * - State reads return defensive copies to prevent external mutation;
 * - State transitions use compare-and-swap semantics where applicable.
 *
 * This implementation is per-(CircuitBreakerKey, CircuitBreakerConfig) and is
 * normally created via InMemoryCircuitBreakerFactory and shared through
 * InMemoryCircuitBreakerRegistry.
 */
export class InMemoryCircuitBreaker implements ICircuitBreaker {
  private readonly key: CircuitBreakerKey;
  private readonly config: CircuitBreakerConfig;
  private readonly eventObserver: ICircuitBreakerEventObserver;
  private _state: CircuitBreakerState;
  private _metrics: CircuitBreakerMetrics;
  private lastTripInfo: CircuitBreakerTripInfo | null = null;
  private readonly handlers = new Map<string, CircuitBreakerEventHandler>();
  private nextHandlerId = 1;
  private readonly _recentOutcomes: boolean[] = []; // true = success, false = failure/timeout
  private _halfOpenProbeAttempts = 0;
  private closed = false;
  private readonly stateMutex = new AsyncMutex();

  constructor(
    key: string | CircuitBreakerKey,
    config: CircuitBreakerConfig | LegacyCircuitBreakerConfig,
    eventObserver: ICircuitBreakerEventObserver = new NoopCircuitBreakerEventObserver(),
  ) {
    this.key = normalizeCircuitBreakerKey(key);
    this.config = normalizeCircuitBreakerConfig(
      config,
      typeof key === 'string' ? key : undefined,
    );
    this.eventObserver = eventObserver;

    const now = new Date();
    this._state = 'CLOSED';
    this._metrics = {
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

    this.recordStateMetric();
  }

  /**
   * Gets a snapshot of current state for atomic operations.
   * Must be called within mutex lock.
   */
  private getStateSnapshot(): CircuitBreakerStateSnapshot {
    return {
      state: this._state,
      metrics: { ...this._metrics },
      halfOpenProbeAttempts: this._halfOpenProbeAttempts,
      recentOutcomes: [...this._recentOutcomes],
    };
  }

  async execute<T>(
    operation: () => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<CircuitBreakerResult<T>> {
    const start = this.now();

    if (this.closed) {
      const error = new Error('CircuitBreaker is closed() and cannot be used');
      return {
        success: false,
        data: undefined,
        error,
        circuitBreakerWasOpen: false,
        durationMs: 0,
      };
    }

    // Phase 1: Check state under lock to determine if call is allowed
    const checkResult = await this.checkCallAllowed();

    if (!checkResult.allowed) {
      const error = new CircuitOpenError(
        checkResult.reason || 'Circuit breaker is OPEN. Call blocked.',
        this.configName,
      );

      const durationMs = this.now() - start;
      return {
        success: false,
        data: undefined,
        error,
        circuitBreakerWasOpen: true,
        durationMs,
      };
    }

    // Phase 2: Execute operation (outside lock to allow concurrent operations)
    const timeoutMs = options?.timeoutMs;
    let error: Error | undefined;
    let data: T | undefined;
    let isTimeout = false;

    try {
      const promise = operation();
      const result = timeoutMs && timeoutMs > 0
        ? await this.withTimeout(promise, timeoutMs)
        : await promise;
      data = result;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      if (isCircuitBreakerTimeoutError(error)) {
        isTimeout = true;
      }
    }

    // Phase 3: Record outcome under lock
    await this.recordOutcome(!error, error, isTimeout);

    const durationMs = this.now() - start;
    const success = !error;

    return {
      success,
      data,
      error,
      circuitBreakerWasOpen: false,
      durationMs,
    };
  }

  /**
   * Checks if a call is allowed under mutex protection.
   * Handles state transitions for OPEN → HALF_OPEN and probe limit checks.
   */
  private async checkCallAllowed(): Promise<{ allowed: boolean; reason?: string }> {
    const release = await this.stateMutex.acquire();
    try {
      // Check if breaker is OPEN and reset timeout hasn't expired
      if (this._state === 'OPEN' && !this.shouldAttemptReset()) {
        this._metrics.rejectedCalls += 1;
        this.updateErrorRate();
        this.recordBlockedCallMetric();
        return { allowed: false, reason: 'Circuit breaker is OPEN. Call blocked.' };
      }

      // Transition from OPEN to HALF_OPEN if reset timeout expired
      if (this._state === 'OPEN' && this.shouldAttemptReset()) {
        this.transitionToHalfOpen('TIMEOUT_EXPIRED');
      }

      // Check HALF_OPEN probe limit
      if (
        this._state === 'HALF_OPEN' &&
        this.config.halfOpenProbeCount > 0 &&
        this._halfOpenProbeAttempts >= this.config.halfOpenProbeCount
      ) {
        const before = this._state;
        this._state = 'OPEN';
        this._metrics.state = 'OPEN';
        this._metrics.stateChangedAt = new Date();
        this._halfOpenProbeAttempts = 0;
        this._metrics.rejectedCalls += 1;
        this.updateErrorRate();
        this.recordStateMetric();
        this.recordTripMetric(before, 'OPEN', 'FAILURE_THRESHOLD_EXCEEDED');
        this.emitLifecycleEvent(
          createCircuitOpenedEvent({
            breakerKey: this.key,
            stateBefore: before,
            metricsBefore: { ...this._metrics },
            metricsAfter: { ...this._metrics },
            reasonCode: 'THRESHOLD_EXCEEDED',
          }),
        );
        this.recordBlockedCallMetric();
        return { allowed: false, reason: 'Circuit breaker HALF_OPEN probe limit reached. Staying OPEN.' };
      }

      return { allowed: true };
    } finally {
      release();
    }
  }

  /**
   * Records operation outcome and handles state transitions under mutex protection.
   */
  private async recordOutcome(success: boolean, error?: Error, isTimeout = false): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      const now = new Date();

      if (success) {
        this._metrics.successes += 1;
        this._metrics.lastSuccessAt = now;
        this.pushOutcome(true);
        this.updateErrorRate();

        if (this._state === 'HALF_OPEN') {
          this._halfOpenProbeAttempts += 1;
          this.recordHalfOpenProbeMetric('success');
          this.dispatchToHandlersHalfOpenSuccess();

          const required = this.config.successThreshold;
          if (required > 0 && this._halfOpenProbeAttempts >= required) {
            this.transitionToClosed('RECOVERY_CONFIRMED');
          }
        }
      } else {
        if (isTimeout) {
          this._metrics.timeouts += 1;
        } else {
          this._metrics.failures += 1;
        }
        this._metrics.lastFailureAt = now;
        this.pushOutcome(false);
        this.updateErrorRate();

        if (this._state === 'HALF_OPEN') {
          this._halfOpenProbeAttempts += 1;
          this.recordHalfOpenProbeMetric('failure');
          this._metrics.halfOpenToOpen += 1;
          this.open(isTimeout ? 'TIMEOUT_EXCEEDED' : 'FAILURE_THRESHOLD_EXCEEDED', error);
          this.dispatchToHandlersHalfOpenFailure(error || new Error('Unknown error'));
        } else if (this._state === 'CLOSED') {
          const failuresInWindow = this.countFailuresInWindow();
          if (
            this.config.failureThreshold > 0 &&
            failuresInWindow >= this.config.failureThreshold
          ) {
            this.open(
              isTimeout ? 'TIMEOUT_EXCEEDED' : 'FAILURE_THRESHOLD_EXCEEDED',
              error,
            );
          }
        }
      }
    } finally {
      release();
    }
  }

  /**
   * Returns current metrics as a defensive copy.
   * Best-effort read - for guaranteed consistency under concurrency, use getMetricsAsync().
   */
  getMetrics(): CircuitBreakerMetrics {
    return this.getMetricsSnapshot();
  }

  /**
   * Async version of getMetrics that guarantees consistency.
   */
  async getMetricsAsync(): Promise<CircuitBreakerMetrics> {
    const release = await this.stateMutex.acquire();
    try {
      return this.getMetricsSnapshot();
    } finally {
      release();
    }
  }

  private getMetricsSnapshot(): CircuitBreakerMetrics {
    return {
      ...this._metrics,
      lastFailureAt: this._metrics.lastFailureAt
        ? new Date(this._metrics.lastFailureAt)
        : undefined,
      lastSuccessAt: this._metrics.lastSuccessAt
        ? new Date(this._metrics.lastSuccessAt)
        : undefined,
      stateChangedAt: new Date(this._metrics.stateChangedAt),
    };
  }

  getState(): CircuitBreakerState {
    // Best-effort read of current state
    return this._state;
  }

  /**
   * Gets state with guaranteed consistency.
   */
  async getStateAsync(): Promise<CircuitBreakerState> {
    const release = await this.stateMutex.acquire();
    try {
      return this._state;
    } finally {
      release();
    }
  }

  async forceOpen(reason: string): Promise<boolean> {
    const release = await this.stateMutex.acquire();
    try {
      if (this.closed) return false;
      this.open('MANUAL_OPEN', new Error(reason));
      return true;
    } finally {
      release();
    }
  }

  async forceClose(): Promise<boolean> {
    const release = await this.stateMutex.acquire();
    try {
      if (this.closed) return false;
      this.transitionToClosed('MANUAL_OVERRIDE');
      return true;
    } finally {
      release();
    }
  }

  async reset(): Promise<boolean> {
    const release = await this.stateMutex.acquire();
    try {
      if (this.closed) return false;
      const now = new Date();
      this._state = 'CLOSED';
      this._metrics = {
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
      this._recentOutcomes.length = 0;
      this._halfOpenProbeAttempts = 0;
      this.lastTripInfo = null;
      this.recordStateMetric();
      return true;
    } finally {
      release();
    }
  }

  addEventHandler(handler: CircuitBreakerEventHandler): string {
    const id = String(this.nextHandlerId++);
    this.handlers.set(id, handler);
    return id;
  }

  removeEventHandler(handlerId: string): boolean {
    return this.handlers.delete(handlerId);
  }

  /**
   * Best-effort synchronous check if call is allowed.
   * For guaranteed consistency under concurrency, use execute() which provides proper synchronization.
   */
  isCallAllowed(): boolean {
    // Fast-path check without lock for best performance
    // This is inherently racy but acceptable for a pre-flight check
    if (this._state === 'OPEN' && !this.shouldAttemptReset()) {
      return false;
    }
    if (
      this._state === 'HALF_OPEN' &&
      this.config.halfOpenProbeCount > 0 &&
      this._halfOpenProbeAttempts >= this.config.halfOpenProbeCount
    ) {
      return false;
    }
    return true;
  }

  /**
   * Async version of isCallAllowed with guaranteed consistency.
   */
  async isCallAllowedAsync(): Promise<boolean> {
    const release = await this.stateMutex.acquire();
    try {
      if (this._state === 'OPEN' && !this.shouldAttemptReset()) {
        return false;
      }
      if (
        this._state === 'HALF_OPEN' &&
        this.config.halfOpenProbeCount > 0 &&
        this._halfOpenProbeAttempts >= this.config.halfOpenProbeCount
      ) {
        return false;
      }
      return true;
    } finally {
      release();
    }
  }

  getLastTripInfo(): CircuitBreakerTripInfo | null {
    if (!this.lastTripInfo) return null;
    return {
      ...this.lastTripInfo,
      metrics: {
        ...this.lastTripInfo.metrics,
        lastFailureAt: this.lastTripInfo.metrics.lastFailureAt
          ? new Date(this.lastTripInfo.metrics.lastFailureAt)
          : undefined,
        lastSuccessAt: this.lastTripInfo.metrics.lastSuccessAt
          ? new Date(this.lastTripInfo.metrics.lastSuccessAt)
          : undefined,
        stateChangedAt: new Date(this.lastTripInfo.metrics.stateChangedAt),
      },
    };
  }

  async isHealthy(): Promise<boolean> {
    const release = await this.stateMutex.acquire();
    try {
      return this._state !== 'OPEN';
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      this.closed = true;
      this.handlers.clear();
    } finally {
      release();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal helpers (must be called within mutex lock)
  // ─────────────────────────────────────────────────────────────────────────────

  private get configName(): string | undefined {
    return this.config.name;
  }

  private getTracingContext(): CircuitBreakerEventTracingContext | undefined {
    const ctx = AsyncLocalRequestContext.getCurrent();
    if (!ctx) return undefined;
    return {
      correlationId: ctx.correlationId,
      traceId: ctx.masTraceId as string | undefined,
      masSessionId: ctx.masSessionId as string | undefined,
    };
  }

  private now(): number {
    return Date.now();
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (ms <= 0) {
      return promise;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('CircuitBreaker operation timed out') as CircuitBreakerTimeoutError;
        error.__cbTimeout = true;
        reject(error);
      }, ms);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private getSlidingWindowSize(): number {
    return this.config.slidingWindowSize ?? 0;
  }

  private pushOutcome(success: boolean): void {
    const windowSize = this.getSlidingWindowSize();
    if (windowSize > 0) {
      this._recentOutcomes.push(success);
      if (this._recentOutcomes.length > windowSize) {
        this._recentOutcomes.shift();
      }
    }
  }

  private countFailuresInWindow(): number {
    if (this.getSlidingWindowSize() <= 0) {
      return this._metrics.failures;
    }
    return this._recentOutcomes.filter((ok) => !ok).length;
  }

  private updateErrorRate(): void {
    const total =
      this._metrics.successes + this._metrics.failures + this._metrics.timeouts;
    if (total === 0) {
      this._metrics.errorRate = 0;
      return;
    }
    const errors = this._metrics.failures + this._metrics.timeouts;
    this._metrics.errorRate = (errors / total) * 100;
  }

  private shouldAttemptReset(): boolean {
    const openDurationMs = this.config.openStateDurationMs;
    const cooldownMs = this.config.cooldownMs ?? 0;
    const threshold = openDurationMs + cooldownMs;
    const elapsed =
      this.now() - this._metrics.stateChangedAt.getTime();
    return elapsed >= threshold;
  }

  private open(reason: 'FAILURE_THRESHOLD_EXCEEDED' | 'TIMEOUT_EXCEEDED' | 'MANUAL_OPEN' | 'FORCED_OPEN', lastError?: Error): void {
    const before = this._state;
    this._state = 'OPEN';
    this._metrics.state = 'OPEN';
    this._metrics.stateChangedAt = new Date();
    this._halfOpenProbeAttempts = 0;

    this.lastTripInfo = {
      reason:
        reason === 'FAILURE_THRESHOLD_EXCEEDED'
          ? 'FAILURE_THRESHOLD_EXCEEDED'
          : reason === 'TIMEOUT_EXCEEDED'
          ? 'TIMEOUT_EXCEEDED'
          : reason === 'MANUAL_OPEN'
          ? 'MANUAL_OPEN'
          : 'FORCED_OPEN',
      trippedAt: new Date(),
      metrics: this.getMetricsSnapshot(),
      lastError,
    };

    this.recordStateMetric();
    this.recordTripMetric(before, 'OPEN', reason);
    this.emitLifecycleEvent(
      createCircuitOpenedEvent({
        breakerKey: this.key,
        stateBefore: before,
        metricsBefore: this.getMetricsSnapshot(),
        metricsAfter: this.getMetricsSnapshot(),
        reasonCode:
          reason === 'FAILURE_THRESHOLD_EXCEEDED'
            ? 'THRESHOLD_EXCEEDED'
            : reason === 'TIMEOUT_EXCEEDED'
            ? 'TIMEOUT_EXPIRED'
            : 'MANUAL_OVERRIDE',
        context: this.getTracingContext(),
      }),
    );
    this.dispatchToHandlersOnOpen();
  }

  private transitionToHalfOpen(reasonCode: 'TIMEOUT_EXPIRED' | 'MANUAL_OVERRIDE' | 'UNKNOWN'): void {
    const before = this._state;
    this._state = 'HALF_OPEN';
    this._metrics.state = 'HALF_OPEN';
    this._metrics.stateChangedAt = new Date();
    this._halfOpenProbeAttempts = 0;

    this.recordStateMetric();
    this.recordTripMetric(before, 'HALF_OPEN', reasonCode);
    this.emitLifecycleEvent(
      createCircuitHalfOpenedEvent({
        breakerKey: this.key,
        stateBefore: before,
        metricsBefore: this.getMetricsSnapshot(),
        metricsAfter: this.getMetricsSnapshot(),
        reasonCode,
        context: this.getTracingContext(),
      }),
    );
    this.dispatchToHandlersOnHalfOpen();
  }

  private transitionToClosed(reasonCode: 'RECOVERY_CONFIRMED' | 'MANUAL_OVERRIDE'): void {
    const before = this._state;
    this._state = 'CLOSED';
    this._metrics.state = 'CLOSED';
    this._metrics.stateChangedAt = new Date();
    this._metrics.halfOpenToClosed += 1;
    this._halfOpenProbeAttempts = 0;

    this.recordStateMetric();
    this.recordTripMetric(before, 'CLOSED', reasonCode);
    this.emitLifecycleEvent(
      createCircuitClosedEvent({
        breakerKey: this.key,
        stateBefore: before,
        metricsBefore: this.getMetricsSnapshot(),
        metricsAfter: this.getMetricsSnapshot(),
        reasonCode,
        context: this.getTracingContext(),
      }),
    );
    this.dispatchToHandlersOnClose();
  }

  private recordStateMetric(): void {
    if (this.config.metricsEnabled === false) {
      return;
    }
    recordCircuitBreakerState(this.key, this._state);
  }

  private recordTripMetric(
    stateBefore: CircuitBreakerState,
    stateAfter: CircuitBreakerState,
    reason: string,
  ): void {
    if (this.config.metricsEnabled === false) {
      return;
    }
    recordCircuitBreakerTrip({
      key: this.key,
      stateBefore,
      stateAfter,
      reason,
    });
  }

  private recordBlockedCallMetric(): void {
    if (
      this.config.metricsEnabled === false ||
      this.config.blockedCallsMetricsEnabled === false
    ) {
      return;
    }
    recordCircuitBreakerBlockedCall(this.key);
  }

  private recordHalfOpenProbeMetric(outcome: 'success' | 'failure'): void {
    if (this.config.metricsEnabled === false) {
      return;
    }
    recordCircuitBreakerHalfOpenProbe({
      key: this.key,
      outcome,
    });
  }

  private emitLifecycleEvent(event: CircuitBreakerEvent): void {
    try {
      this.eventObserver.onEvent(event);
    } catch {
      // Observer errors must not break the breaker or affect user operations.
    }
  }

  private dispatchToHandlersOnOpen(): void {
    const info = this.lastTripInfo;
    if (!info) return;
    for (const handler of this.handlers.values()) {
      if (handler.onOpen) {
        try {
          handler.onOpen(info);
        } catch {
          // Handlers must not break the breaker itself.
        }
      }
    }
  }

  private dispatchToHandlersOnClose(): void {
    const metricsSnapshot = this.getMetricsSnapshot();
    for (const handler of this.handlers.values()) {
      if (handler.onClose) {
        try {
          handler.onClose(metricsSnapshot);
        } catch {
          // Ignore handler errors.
        }
      }
    }
  }

  private dispatchToHandlersOnHalfOpen(): void {
    const metricsSnapshot = this.getMetricsSnapshot();
    for (const handler of this.handlers.values()) {
      if (handler.onHalfOpen) {
        try {
          handler.onHalfOpen(metricsSnapshot);
        } catch {
          // Ignore handler errors.
        }
      }
    }
  }

  private dispatchToHandlersHalfOpenSuccess(): void {
    const metricsSnapshot = this.getMetricsSnapshot();
    for (const handler of this.handlers.values()) {
      if (handler.onHalfOpenSuccess) {
        try {
          handler.onHalfOpenSuccess(metricsSnapshot);
        } catch {
          // Ignore handler errors.
        }
      }
    }
  }

  private dispatchToHandlersHalfOpenFailure(error: Error): void {
    const metricsSnapshot = this.getMetricsSnapshot();
    for (const handler of this.handlers.values()) {
      if (handler.onHalfOpenFailure) {
        try {
          handler.onHalfOpenFailure(error, metricsSnapshot);
        } catch {
          // Ignore handler errors.
        }
      }
    }
  }
}

/**
 * Simple factory for InMemoryCircuitBreaker used by the registry.
 */
export class InMemoryCircuitBreakerFactory implements ICircuitBreakerFactory {
  constructor(
    private readonly eventObserver: ICircuitBreakerEventObserver,
  ) {}

  createBreaker(
    key: CircuitBreakerKey,
    config: CircuitBreakerConfig,
  ): ICircuitBreaker {
    return new InMemoryCircuitBreaker(key, config, this.eventObserver);
  }
}
