import type { CircuitBreakerState } from '../domain/external/ICircuitBreaker';
import type { CircuitBreakerKey } from '../core/resilience/CircuitBreakerKey';
import { getMetricsLabelsFromKey } from '../core/resilience/CircuitBreakerKey';
import {
  getOrCreateCounter,
  getOrCreateGauge,
} from './registry';

/**
 * Resilience / Circuit Breaker metrics facade.
 *
 * Layer: Monitoring.
 *
 * All metrics are created via src/monitoring/index.ts helpers to respect
 * global metrics configuration and registry reuse.
 */

const BREAKER_STATE_GAUGE_NAME = 'resilience_breaker_state';
const BREAKER_TRIPS_COUNTER_NAME = 'resilience_breaker_trips_total';
const BREAKER_BLOCKED_CALLS_COUNTER_NAME =
  'resilience_breaker_blocked_calls_total';
const BREAKER_HALF_OPEN_PROBES_COUNTER_NAME =
  'resilience_breaker_half_open_probes_total';

type BaseLabels = {
  channel: string;
  service: string;
  operation: string;
  environment: string;
  tenant: string;
};

function buildBaseLabels(key: CircuitBreakerKey): BaseLabels {
  const raw = getMetricsLabelsFromKey(key);
  const channel = raw.channel ?? key.channel;
  const service = raw.service ?? key.serviceName;
  const operation = raw.operation ?? key.operation;
  const environment = raw.environment ?? key.environment;
  const tenant = raw.tenant ?? key.tenantId ?? 'unknown';

  return { channel, service, operation, environment, tenant };
}

// Keep module-load metric registration on the registry surface so index.ts can
// re-export this facade without creating a circular initialization path.
const breakerStateGauge = getOrCreateGauge(
  BREAKER_STATE_GAUGE_NAME,
  'Current state of circuit breakers (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
  ['channel', 'service', 'operation', 'environment', 'tenant'],
);

const breakerTripsTotal = getOrCreateCounter(
  BREAKER_TRIPS_COUNTER_NAME,
  'Total number of circuit breaker state transitions (trips)',
  ['channel', 'service', 'operation', 'environment', 'tenant', 'state_before', 'state_after', 'reason'],
);

const breakerBlockedCallsTotal = getOrCreateCounter(
  BREAKER_BLOCKED_CALLS_COUNTER_NAME,
  'Total number of calls blocked by OPEN circuit breakers',
  ['channel', 'service', 'operation', 'environment', 'tenant'],
);

const breakerHalfOpenProbesTotal = getOrCreateCounter(
  BREAKER_HALF_OPEN_PROBES_COUNTER_NAME,
  'Total number of HALF_OPEN probe calls by outcome',
  ['channel', 'service', 'operation', 'environment', 'tenant', 'outcome'],
);

function stateToNumeric(state: CircuitBreakerState): number {
  switch (state) {
    case 'CLOSED':
      return 0;
    case 'OPEN':
      return 1;
    case 'HALF_OPEN':
      return 2;
    default:
      return -1;
  }
}

/**
 * Update the state gauge for a breaker.
 */
export function recordCircuitBreakerState(
  key: CircuitBreakerKey,
  state: CircuitBreakerState,
): void {
  const labels = buildBaseLabels(key);
  breakerStateGauge.set(labels, stateToNumeric(state));
}

/**
 * Increment trip counter when breaker transitions between states.
 */
export function recordCircuitBreakerTrip(params: {
  key: CircuitBreakerKey;
  stateBefore: CircuitBreakerState;
  stateAfter: CircuitBreakerState;
  reason?: string;
}): void {
  const base = buildBaseLabels(params.key);
  breakerTripsTotal.inc({
    ...base,
    state_before: params.stateBefore,
    state_after: params.stateAfter,
    reason: params.reason ?? 'unknown',
  });
}

/**
 * Increment blocked-call counter when a call is rejected because
 * the breaker is OPEN.
 */
export function recordCircuitBreakerBlockedCall(
  key: CircuitBreakerKey,
): void {
  const labels = buildBaseLabels(key);
  breakerBlockedCallsTotal.inc(labels);
}

/**
 * Increment HALF_OPEN probe counter.
 */
export function recordCircuitBreakerHalfOpenProbe(params: {
  key: CircuitBreakerKey;
  outcome: 'success' | 'failure';
}): void {
  const base = buildBaseLabels(params.key);
  breakerHalfOpenProbesTotal.inc({
    ...base,
    outcome: params.outcome,
  });
}