import type {
  CircuitBreakerState,
  CircuitBreakerMetrics,
} from '../../domain/external/ICircuitBreaker';
import type { CircuitBreakerKey } from './CircuitBreakerKey';

/**
 * Circuit breaker lifecycle events (core types only).
 *
 * Layer: Core/Resilience.
 *
 * These events are pure TypeScript DTOs without any coupling to EventStore
 * or infrastructure. Infra can later map them to typed events/outbox records.
 */

export type CircuitBreakerEventReasonCode =
  | 'THRESHOLD_EXCEEDED'
  | 'MANUAL_OVERRIDE'
  | 'TIMEOUT_EXPIRED'
  | 'HEALTHCHECK_FAILED'
  | 'POLICY_ENFORCED'
  | 'RECOVERY_CONFIRMED'
  | 'UNKNOWN';

/**
 * Base shape for all circuit breaker events.
 */
export interface CircuitBreakerEventBase {
  breakerKey: CircuitBreakerKey;
  stateBefore: CircuitBreakerState;
  stateAfter: CircuitBreakerState;
  reasonCode: CircuitBreakerEventReasonCode | string;
  occurredAt: Date;
  metricsBefore?: CircuitBreakerMetrics;
  metricsAfter?: CircuitBreakerMetrics;

  /**
   * Optional tracing identifiers for external observability/tracing systems.
   *
   * - correlationId: обычно берётся из RequestContext.correlationId
   *   (src/application/context/request-context.ts).
   * - traceId/spanId: из будущего OpenTelemetry-совместимого контекста
   *   или MAS-контекста.
   * - masSessionId/masTaskId: из MasSessionContext / MasTask
   *   (src/application/agents/context/mas-request-context.ts,
   *    src/application/agents/types/mas-types.ts).
   *
   * Все поля опциональны; отсутствие допустимо, но при наличии контекста
   * рекомендуется их заполнять для последующей OTEL-интеграции.
   */
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  masSessionId?: string;
  masTaskId?: string;
}

/**
 * Narrow tracing context subset that can be passed into helper factories.
 * Mirrors tracing-related fields from CircuitBreakerEventBase.
 */
export type CircuitBreakerEventTracingContext = Pick<
  CircuitBreakerEventBase,
  'correlationId' | 'traceId' | 'spanId' | 'masSessionId' | 'masTaskId'
>;

/**
 * Emitted when breaker transitions into OPEN.
 */
export interface CircuitOpenedEvent extends CircuitBreakerEventBase {
  type: 'CircuitOpened';
}

/**
 * Emitted when breaker transitions into HALF_OPEN.
 */
export interface CircuitHalfOpenedEvent extends CircuitBreakerEventBase {
  type: 'CircuitHalfOpened';
}

/**
 * Emitted when breaker transitions into CLOSED.
 */
export interface CircuitClosedEvent extends CircuitBreakerEventBase {
  type: 'CircuitClosed';
}

export type CircuitBreakerEvent =
  | CircuitOpenedEvent
  | CircuitHalfOpenedEvent
  | CircuitClosedEvent;

export function createCircuitOpenedEvent(params: {
  breakerKey: CircuitBreakerKey;
  stateBefore: CircuitBreakerState;
  metricsBefore?: CircuitBreakerMetrics;
  metricsAfter?: CircuitBreakerMetrics;
  reasonCode?: CircuitBreakerEventReasonCode | string;
  occurredAt?: Date;
  context?: CircuitBreakerEventTracingContext;
}): CircuitOpenedEvent {
  return {
    type: 'CircuitOpened',
    breakerKey: params.breakerKey,
    stateBefore: params.stateBefore,
    stateAfter: 'OPEN',
    reasonCode: params.reasonCode ?? 'THRESHOLD_EXCEEDED',
    occurredAt: params.occurredAt ?? new Date(),
    metricsBefore: params.metricsBefore,
    metricsAfter: params.metricsAfter,
    ...params.context,
  };
}

export function createCircuitHalfOpenedEvent(params: {
  breakerKey: CircuitBreakerKey;
  stateBefore: CircuitBreakerState;
  metricsBefore?: CircuitBreakerMetrics;
  metricsAfter?: CircuitBreakerMetrics;
  reasonCode?: CircuitBreakerEventReasonCode | string;
  occurredAt?: Date;
  context?: CircuitBreakerEventTracingContext;
}): CircuitHalfOpenedEvent {
  return {
    type: 'CircuitHalfOpened',
    breakerKey: params.breakerKey,
    stateBefore: params.stateBefore,
    stateAfter: 'HALF_OPEN',
    reasonCode: params.reasonCode ?? 'TIMEOUT_EXPIRED',
    occurredAt: params.occurredAt ?? new Date(),
    metricsBefore: params.metricsBefore,
    metricsAfter: params.metricsAfter,
    ...params.context,
  };
}

export function createCircuitClosedEvent(params: {
  breakerKey: CircuitBreakerKey;
  stateBefore: CircuitBreakerState;
  metricsBefore?: CircuitBreakerMetrics;
  metricsAfter?: CircuitBreakerMetrics;
  reasonCode?: CircuitBreakerEventReasonCode | string;
  occurredAt?: Date;
  context?: CircuitBreakerEventTracingContext;
}): CircuitClosedEvent {
  return {
    type: 'CircuitClosed',
    breakerKey: params.breakerKey,
    stateBefore: params.stateBefore,
    stateAfter: 'CLOSED',
    reasonCode: params.reasonCode ?? 'RECOVERY_CONFIRMED',
    occurredAt: params.occurredAt ?? new Date(),
    metricsBefore: params.metricsBefore,
    metricsAfter: params.metricsAfter,
    ...params.context,
  };
}