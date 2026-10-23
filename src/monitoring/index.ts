import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { Registry, register as globalRegister, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';
import {
  AGENT_SPAN_CORRELATION_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_ERROR_TYPE,
  GEN_AI_MEMORY_RECORD_COUNT,
  GEN_AI_MEMORY_STORE_ID,
  GEN_AI_OPERATION_CREATE_MEMORY,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_SEARCH_MEMORY,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  PROCESS_EXECUTABLE_NAME,
  PROCESS_EXIT_CODE,
  MCP_META_TRACEPARENT,
  MCP_METHOD_NAME,
  MCP_PROTOCOL_VERSION,
  MCP_SESSION_ID,
} from './genai-semconv';
import { withConcurrencyLimit, DEFAULT_CONCURRENCY } from '../core/utils/concurrency-limiter';
import { container } from '../core/di/container';
import { getMetricsConfig } from '../core/config/app-config';
import { logger } from '../infrastructure/logging/logger';

const { enabled: METRICS_ENABLED } = getMetricsConfig();

let registry: Registry = globalRegister;
let defaultMetricsRegistered = false;
let defaultMetricsFailure: string | null = null;

// Track metric registration failures for meta-monitoring
interface MetricRegistrationFailure {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  error: string;
  timestamp: number;
}

const registrationFailures: MetricRegistrationFailure[] = [];
const MAX_FAILURES_HISTORY = 100;

/**
 * Get recent metric registration failures for health monitoring
 */
export function getRecentRegistrationFailures(): MetricRegistrationFailure[] {
  return [...registrationFailures];
}

/**
 * Get count of metric registration failures
 */
export function getRegistrationFailureCount(): number {
  return registrationFailures.length;
}

function recordRegistrationFailure(name: string, type: 'counter' | 'histogram' | 'gauge', error: unknown): void {
  const failure: MetricRegistrationFailure = {
    name,
    type,
    error: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };

  registrationFailures.push(failure);

  // Keep only recent failures
  if (registrationFailures.length > MAX_FAILURES_HISTORY) {
    registrationFailures.shift();
  }

  logger.error('Failed to register metric', {
    metricName: name,
    metricType: type,
    error: failure.error,
  });
}

// No-op metric type definitions - compatible with prom-client interfaces
// We use 'as unknown as Type' casting to avoid implementing all internal details
// while providing the same public API for safe fallback

type NoOpCounterType = Counter<string> & {
  inc(labels?: Record<string, string | number>, value?: number): void;
  inc(value?: number): void;
};

type NoOpHistogramType = Histogram<string> & {
  observe(labels: Record<string, string | number>, value: number): void;
  observe(value: number): void;
  startTimer(labels?: Record<string, string | number>): () => number;
};

type NoOpGaugeType = Gauge<string> & {
  set(labels: Record<string, string | number>, value: number): void;
  set(value: number): void;
};

// No-op implementations that match the methods we actually use
const noOpCounter: NoOpCounterType = {
  inc: (labelsOrValue?: Record<string, string | number> | number, _value?: number): void => {
    // No-op: metric registration failed, silently ignore
  },
   
  get: async () => ({ values: [] } as unknown as Awaited<ReturnType<Counter<string>['get']>>),
  reset: (): void => {
    // No-op
  },
  labels: (): NoOpCounterType => noOpCounter,
  remove: (): void => {
    // No-op
  },
} as unknown as NoOpCounterType;

const noOpHistogram: NoOpHistogramType = {
  observe: (labelsOrValue: Record<string, string | number> | number, _value?: number): void => {
    // No-op: metric registration failed, silently ignore
  },
  startTimer: (_labels?: Record<string, string | number>): (() => number) => {
    return () => 0;
  },
   
  get: async () => ({ values: [] } as unknown as Awaited<ReturnType<Histogram<string>['get']>>),
  reset: (): void => {
    // No-op
  },
  labels: (): NoOpHistogramType => noOpHistogram,
  remove: (): void => {
    // No-op
  },
  zero: (): void => {
    // No-op
  },
} as unknown as NoOpHistogramType;

const noOpGauge: NoOpGaugeType = {
  set: (labelsOrValue: Record<string, string | number> | number, _value?: number): void => {
    // No-op: metric registration failed, silently ignore
  },
   
  get: async () => ({ values: [] } as unknown as Awaited<ReturnType<Gauge<string>['get']>>),
  reset: (): void => {
    // No-op
  },
  labels: (): NoOpGaugeType => noOpGauge,
  remove: (): void => {
    // No-op
  },
} as unknown as NoOpGaugeType;

export function getRegistry(): Registry {
  return registry;
}

export { globalRegister };

export function clearRegistry(): void {
  registry.resetMetrics();
  registrationFailures.length = 0;
  defaultMetricsFailure = null;
  defaultMetricsRegistered = false;
  policyAuditLagSamples.clear();
  healthCheckers.clear();

  // Null all cached metric singletons so they get re-created lazily (TEST-043)
  policyEvaluationsCounter = null;
  policyEvalLatencyHistogram = null;
  policyDenialsCounter = null;
  policyBudgetRemainingGauge = null;
  policyAuditBacklogGauge = null;
  pluginSandboxViolationsTotal = null;
  pythonSkillSecurityRejectionsTotal = null;
  toolCallsTotal = null;
  toolCallDurationSeconds = null;
  mcpRouterRequestsTotal = null;
  mcpRouterLatencySeconds = null;
  mcpStreamableRequestsTotal = null;
  mcpStreamableLatencySeconds = null;
  mcpStreamableActiveSessions = null;
  chatMmRequestsTotal = null;
  chatMmErrorsTotal = null;
  chatMmLatencyMs = null;

  registerDefaultHealthChecks();
}

export function registerDefaultMetrics(): void {
  if (!METRICS_ENABLED) return;
  if (defaultMetricsRegistered) return;
  try {
    collectDefaultMetrics({ register: registry });
    defaultMetricsRegistered = true;
    defaultMetricsFailure = null;
  } catch (error) {
    // Log but don't throw - default metrics failure shouldn't break the app
    defaultMetricsFailure = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to register default metrics', { error: defaultMetricsFailure });
  }
}

export function getOrCreateCounter(name: string, help: string, labelNames: string[] = []): Counter<string> {
  try {
    const registryWithMetrics = registry as { getSingleMetric?: (name: string) => Counter<string> | undefined };
    const existing = registryWithMetrics.getSingleMetric?.(name);
    if (existing) return existing;
    return new Counter({ name, help, labelNames, registers: [registry] });
  } catch (error) {
    recordRegistrationFailure(name, 'counter', error);
    return noOpCounter;
  }
}

export function getOrCreateHistogram(name: string, help: string, labelNames: string[] = [], buckets: number[] = []): Histogram<string> {
  try {
    const registryWithMetrics = registry as { getSingleMetric?: (name: string) => Histogram<string> | undefined };
    const existing = registryWithMetrics.getSingleMetric?.(name);
    if (existing) return existing;
    return new Histogram({ name, help, labelNames, buckets: buckets.length ? buckets : [0.01,0.05,0.1,0.25,0.5,1,2,5], registers: [registry] });
  } catch (error) {
    recordRegistrationFailure(name, 'histogram', error);
    return noOpHistogram;
  }
}

export function getOrCreateGauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
  try {
    const registryWithMetrics = registry as { getSingleMetric?: (name: string) => Gauge<string> | undefined };
    const existing = registryWithMetrics.getSingleMetric?.(name);
    if (existing) return existing;
    return new Gauge({ name, help, labelNames, registers: [registry] });
  } catch (error) {
    recordRegistrationFailure(name, 'gauge', error);
    return noOpGauge;
  }
}

const OBS_NEXT_SEC_PE_REF = 'OBS-NEXT.SEC-PE.2 :: 02-PLANNING/P0_ADVANCED_OBSERVABILITY_MONITORING.md#L1078';

const POLICY_EVALUATIONS_COUNTER_NAME = 'policy_evaluations_total';
let policyEvaluationsCounter: Counter<string> | null = null;
export function getPolicyEvaluationsCounter(): Counter<string> {
  if (!policyEvaluationsCounter) {
    policyEvaluationsCounter = getOrCreateCounter(
      POLICY_EVALUATIONS_COUNTER_NAME,
      `Total PolicyEngine evaluations mapped by status per ${OBS_NEXT_SEC_PE_REF}`,
      ['status', 'source', 'resource'],
    );
  }
  return policyEvaluationsCounter;
}

const POLICY_EVAL_LATENCY_HISTOGRAM_NAME = 'policy_eval_latency_seconds';
let policyEvalLatencyHistogram: Histogram<string> | null = null;
export function getPolicyEvalLatencyHistogram(): Histogram<string> {
  if (!policyEvalLatencyHistogram) {
    policyEvalLatencyHistogram = getOrCreateHistogram(
      POLICY_EVAL_LATENCY_HISTOGRAM_NAME,
      `PolicyEngine latency buckets per ${OBS_NEXT_SEC_PE_REF}`,
      ['source', 'resource', 'action'],
    );
  }
  return policyEvalLatencyHistogram;
}

const POLICY_DENIALS_COUNTER_NAME = 'policy_denials_total';
let policyDenialsCounter: Counter<string> | null = null;
export function getPolicyDenialsCounter(): Counter<string> {
  if (!policyDenialsCounter) {
    policyDenialsCounter = getOrCreateCounter(
      POLICY_DENIALS_COUNTER_NAME,
      `PolicyEngine denials grouped by reason per ${OBS_NEXT_SEC_PE_REF}`,
      ['reason', 'severity', 'source'],
    );
  }
  return policyDenialsCounter;
}

const POLICY_BUDGET_GAUGE_NAME = 'policy_budget_remaining_usd';
let policyBudgetRemainingGauge: Gauge<string> | null = null;
export function getPolicyBudgetRemainingGauge(): Gauge<string> {
  if (!policyBudgetRemainingGauge) {
    policyBudgetRemainingGauge = getOrCreateGauge(
      POLICY_BUDGET_GAUGE_NAME,
      `Remaining policy budgets per tenant/window per ${OBS_NEXT_SEC_PE_REF}`,
      ['tenant_id', 'window'],
    );
  }
  return policyBudgetRemainingGauge;
}

const POLICY_AUDIT_BACKLOG_GAUGE_NAME = 'policy_audit_backlog_seconds';
let policyAuditBacklogGauge: Gauge<string> | null = null;
export function getPolicyAuditBacklogGauge(): Gauge<string> {
  if (!policyAuditBacklogGauge) {
    policyAuditBacklogGauge = getOrCreateGauge(
      POLICY_AUDIT_BACKLOG_GAUGE_NAME,
      `Outbox backlog for policy audit events per ${OBS_NEXT_SEC_PE_REF}`,
      ['outbox_partition'],
    );
  }
  return policyAuditBacklogGauge;
}

const policyAuditLagSamples = new Map<string, { value: number; updatedAt: number }>();
const POLICY_AUDIT_LAG_THRESHOLD_SECONDS = 30;
const POLICY_AUDIT_LAG_STALE_MS = 5 * 60 * 1000;

export function recordPolicyAuditBacklog(partition: string, seconds: number): void {
  const gauge = getPolicyAuditBacklogGauge();
  gauge.set({ outbox_partition: partition }, seconds);
  policyAuditLagSamples.set(partition, { value: seconds, updatedAt: Date.now() });
}

export const PLUGIN_SANDBOX_VIOLATIONS_COUNTER_NAME = 'plugin_sandbox_violations_total';

let pluginSandboxViolationsTotal: Counter<string> | null = null;

export function getPluginSandboxViolationsCounter(): Counter<string> {
  if (!pluginSandboxViolationsTotal) {
    pluginSandboxViolationsTotal = getOrCreateCounter(
      PLUGIN_SANDBOX_VIOLATIONS_COUNTER_NAME,
      'Total number of plugin sandbox violations',
      ['plugin_name', 'violation_type'],
    );
  }

  return pluginSandboxViolationsTotal;
}

export const PYTHON_SKILL_SECURITY_REJECTIONS_COUNTER_NAME = 'python_skill_security_rejections_total';

let pythonSkillSecurityRejectionsTotal: Counter<string> | null = null;

export type PythonSkillSecurityViolationReason =
  | 'skill_name_empty'
  | 'skill_name_path_traversal'
  | 'script_path_empty'
  | 'path_traversal'
  | 'script_not_whitelisted'
  | 'too_many_args'
  | 'arg_too_long'
  | 'forbidden_character'
  | 'env_value_too_long';

export interface PythonSkillSecurityMetrics {
  increment(params: {
    reason: PythonSkillSecurityViolationReason;
    skillName: string;
    scriptName: string;
  }): void;
}

export function getPythonSkillSecurityRejectionsCounter(): Counter<string> {
  if (!pythonSkillSecurityRejectionsTotal) {
    pythonSkillSecurityRejectionsTotal = getOrCreateCounter(
      PYTHON_SKILL_SECURITY_REJECTIONS_COUNTER_NAME,
      'Total number of Python skill security rejections grouped by reason, skill and script',
      ['reason', 'skill_name', 'script_name'],
    );
  }

  return pythonSkillSecurityRejectionsTotal;
}

export function createPythonSkillSecurityMetrics(): PythonSkillSecurityMetrics {
  const counter = getPythonSkillSecurityRejectionsCounter();

  return {
    increment: (params) => {
      counter.inc({
        reason: params.reason,
        skill_name: params.skillName,
        script_name: params.scriptName,
      });
    },
  };
}

export const TOOL_CALLS_COUNTER_NAME = 'tool_calls_total';

let toolCallsTotal: Counter<string> | null = null;

export function getToolCallsCounter(): Counter<string> {
  if (!toolCallsTotal) {
    toolCallsTotal = getOrCreateCounter(
      TOOL_CALLS_COUNTER_NAME,
      'Total tool calls grouped by tool and success',
      ['tool_name', 'success'],
    );
  }

  return toolCallsTotal;
}

export const TOOL_CALL_DURATION_HISTOGRAM_NAME = 'tool_call_duration_seconds';

let toolCallDurationSeconds: Histogram<string> | null = null;

export function getToolCallDurationHistogram(): Histogram<string> {
  if (!toolCallDurationSeconds) {
    toolCallDurationSeconds = getOrCreateHistogram(
      TOOL_CALL_DURATION_HISTOGRAM_NAME,
      'Tool call latency in seconds',
      ['tool_name', 'success'],
    );
  }

  return toolCallDurationSeconds;
}

export const MCP_ROUTER_REQUESTS_COUNTER_NAME = 'mcp_router_requests_total';

let mcpRouterRequestsTotal: Counter<string> | null = null;

export function getMcpRouterRequestsCounter(): Counter<string> {
  if (!mcpRouterRequestsTotal) {
    mcpRouterRequestsTotal = getOrCreateCounter(
      MCP_ROUTER_REQUESTS_COUNTER_NAME,
      'Total MCP router requests grouped by result and reason',
      ['result', 'reason'],
    );
  }

  return mcpRouterRequestsTotal;
}

export const MCP_ROUTER_LATENCY_HISTOGRAM_NAME = 'mcp_router_latency_seconds';

let mcpRouterLatencySeconds: Histogram<string> | null = null;

export function getMcpRouterLatencyHistogram(): Histogram<string> {
  if (!mcpRouterLatencySeconds) {
    mcpRouterLatencySeconds = getOrCreateHistogram(
      MCP_ROUTER_LATENCY_HISTOGRAM_NAME,
      'MCP router latency in seconds',
      ['result', 'reason'],
    );
  }

  return mcpRouterLatencySeconds;
}

export const MCP_STREAMABLE_REQUESTS_COUNTER_NAME = 'mcp_streamable_requests_total';

let mcpStreamableRequestsTotal: Counter<string> | null = null;

export function getMcpStreamableRequestsCounter(): Counter<string> {
  if (!mcpStreamableRequestsTotal) {
    mcpStreamableRequestsTotal = getOrCreateCounter(
      MCP_STREAMABLE_REQUESTS_COUNTER_NAME,
      'Total MCP streamable transport requests grouped by method and result',
      ['method', 'result'],
    );
  }

  return mcpStreamableRequestsTotal;
}

export const MCP_STREAMABLE_LATENCY_HISTOGRAM_NAME = 'mcp_streamable_request_duration_seconds';

let mcpStreamableLatencySeconds: Histogram<string> | null = null;

export function getMcpStreamableLatencyHistogram(): Histogram<string> {
  if (!mcpStreamableLatencySeconds) {
    mcpStreamableLatencySeconds = getOrCreateHistogram(
      MCP_STREAMABLE_LATENCY_HISTOGRAM_NAME,
      'MCP streamable transport latency in seconds',
      ['method', 'result'],
    );
  }

  return mcpStreamableLatencySeconds;
}

export const MCP_STREAMABLE_ACTIVE_SESSIONS_GAUGE_NAME = 'mcp_streamable_active_sessions';

let mcpStreamableActiveSessions: Gauge<string> | null = null;

export function getMcpStreamableActiveSessionsGauge(): Gauge<string> {
  if (!mcpStreamableActiveSessions) {
    mcpStreamableActiveSessions = getOrCreateGauge(
      MCP_STREAMABLE_ACTIVE_SESSIONS_GAUGE_NAME,
      'Currently active MCP streamable transport sessions',
    );
  }

  return mcpStreamableActiveSessions;
}

export type HealthComponentStatus = {
  ok: boolean;
  error?: string;
  info?: Record<string, unknown>;
};

export type HealthStatus = {
  ok: boolean;
  components: Record<string, HealthComponentStatus>;
};

type HealthChecker = () => Promise<HealthComponentStatus>;

const healthCheckers = new Map<string, HealthChecker>();

export function registerHealthCheck(name: string, checker: HealthChecker): void {
  healthCheckers.set(name, checker);
}

interface HealthCheckable {
  isHealthy?: () => Promise<boolean> | boolean;
  isAvailable?: () => Promise<boolean> | boolean;
  close?: () => Promise<void>;
  ping?: () => Promise<boolean> | boolean;
  query?: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
}

async function probeService(token: string, preferredMethods: string[]): Promise<HealthComponentStatus> {
  try {
    if (!container.isRegistered(token)) {
      return { ok: false, error: 'not_registered' };
    }

    const svc = container.resolve<HealthCheckable>(token);

    // Используем только реальные методы health-check (isHealthy / isAvailable / ping / тест-запрос)
    for (const m of preferredMethods) {
      if (svc && typeof svc[m] === 'function') {
         
        const method = svc[m] as (this: HealthCheckable) => Promise<unknown>;
        const res = await method.call(svc);
        
        const ok = typeof res === 'boolean'
          ? res
          : !!(res && typeof res === 'object' && (res as { ok?: unknown }).ok);

        if (ok) {
          return { ok: true };
        }

        return { ok: false, error: `${m}_returned_false` };
      }
    }

    // Если компонент зарегистрирован, но не предоставляет ни одного health-метода,
    // считаем его небезопасным для production-health и явно сигнализируем.
    return {
      ok: false,
      error: 'no_health_method',
      info: { note: 'Registered service has no explicit health check method; add isHealthy()/isAvailable()/ping().' }
    };
  } catch (e: unknown) {
    const error = e as { message?: string };
    return { ok: false, error: error?.message || 'health_exception' };
  }
}

function evaluateMetricsRegistrationHealth(): HealthComponentStatus {
  if (defaultMetricsFailure) {
    return {
      ok: false,
      error: 'default_metrics_registration_failed',
      info: {
        failure: defaultMetricsFailure,
        registrationFailureCount: getRegistrationFailureCount(),
      },
    };
  }

  const registrationFailureCount = getRegistrationFailureCount();
  if (registrationFailureCount > 0) {
    return {
      ok: false,
      error: 'metric_registration_failures',
      info: { registrationFailureCount },
    };
  }

  if (!METRICS_ENABLED) {
    return { ok: true, info: { enabled: false } };
  }

  if (!defaultMetricsRegistered) {
    return {
      ok: false,
      error: 'default_metrics_not_registered',
    };
  }

  return {
    ok: true,
    info: {
      registrationFailureCount: 0,
    },
  };
}

export function registerDefaultHealthChecks(): void {
  if (!healthCheckers.has('metrics_registration')) {
    registerHealthCheck('metrics_registration', async () => evaluateMetricsRegistrationHealth());
  }
  if (!healthCheckers.has('database')) {
    registerHealthCheck('database', () =>
      probeService('IDatabaseConnection', ['isConnected', 'isHealthy', 'isAvailable']),
    );
  }
  if (!healthCheckers.has('event_store')) {
    registerHealthCheck('event_store', () => probeService('IEventStore', ['isHealthy']));
  }
  if (!healthCheckers.has('event_bus')) {
    registerHealthCheck('event_bus', () => probeService('IEventBus', ['isHealthy']));
  }
  if (!healthCheckers.has('outbox')) {
    registerHealthCheck('outbox', () => probeService('IOutbox', ['isHealthy']));
  }
  if (!healthCheckers.has('cache')) {
    registerHealthCheck('cache', () =>
      probeService('ICache', ['isAvailable', 'isHealthy']),
    );
  }
  if (!healthCheckers.has('policy_engine')) {
    registerHealthCheck('policy_engine', () =>
      probeService('PolicyEngine', ['isHealthy', 'isAvailable', 'ping']),
    );
  }
  if (!healthCheckers.has('policy_audit_store')) {
    registerHealthCheck('policy_audit_store', async () => evaluatePolicyAuditLag());
  }
  if (!healthCheckers.has('openmemory_hsg')) {
    registerHealthCheck('openmemory_hsg', () =>
      probeService('HSGClient', ['isHealthy', 'isAvailable', 'ping']),
    );
  }
  if (!healthCheckers.has('openmemory_vector')) {
    registerHealthCheck('openmemory_vector', () =>
      probeService('VectorClient', ['isHealthy', 'isAvailable', 'ping']),
    );
  }
}

export async function getOverallHealth(): Promise<HealthStatus> {
  const entries = Array.from(healthCheckers.entries());
  // Bounded concurrency to prevent memory exhaustion with many health checkers (P0-007)
  const results = await withConcurrencyLimit(
    entries,
    DEFAULT_CONCURRENCY,
    async ([name, checker]) => {
      const r = await checker();
      return [name, r] as const;
    }
  );
  const components: Record<string, HealthComponentStatus> = {};
  for (const [name, st] of results) {
    components[name] = st;
  }
  const ok = results.every(([,st]) => st.ok);
  return { ok, components };
}

function evaluatePolicyAuditLag(): HealthComponentStatus {
  if (policyAuditLagSamples.size === 0) {
    return { ok: false, error: 'no_policy_audit_samples' };
  }

  const now = Date.now();
  for (const [partition, sample] of policyAuditLagSamples.entries()) {
    const ageMs = now - sample.updatedAt;
    if (ageMs > POLICY_AUDIT_LAG_STALE_MS) {
      return {
        ok: false,
        error: 'policy_audit_samples_stale',
        info: { partition, staleSeconds: Math.round(ageMs / 1000) },
      };
    }

    if (sample.value > POLICY_AUDIT_LAG_THRESHOLD_SECONDS) {
      return {
        ok: false,
        error: 'policy_audit_backlog_high',
        info: { partition, lagSeconds: sample.value },
      };
    }
  }

  return { ok: true };
}

export * from './resilience-metrics';

// Initialize defaults eagerly (safe to call multiple times)
registerDefaultMetrics();
registerDefaultHealthChecks();
export const CHAT_MM_REQUESTS_COUNTER_NAME = 'chat_mm_requests_total';

let chatMmRequestsTotal: Counter<string> | null = null;

export function getChatMmRequestsCounter(): Counter<string> {
  if (!chatMmRequestsTotal) {
    chatMmRequestsTotal = getOrCreateCounter(
      CHAT_MM_REQUESTS_COUNTER_NAME,
      'Total multimodal chat requests by modality, provider and model',
      ['modality', 'provider', 'model'],
    );
  }

  return chatMmRequestsTotal;
}

export const CHAT_MM_ERRORS_COUNTER_NAME = 'chat_mm_errors_total';

let chatMmErrorsTotal: Counter<string> | null = null;

export function getChatMmErrorsCounter(): Counter<string> {
  if (!chatMmErrorsTotal) {
    chatMmErrorsTotal = getOrCreateCounter(
      CHAT_MM_ERRORS_COUNTER_NAME,
      'Total multimodal chat errors by modality, provider and model',
      ['modality', 'provider', 'model'],
    );
  }

  return chatMmErrorsTotal;
}

export const CHAT_MM_LATENCY_HISTOGRAM_NAME = 'chat_mm_latency_ms';

let chatMmLatencyMs: Histogram<string> | null = null;

export function getChatMmLatencyHistogram(): Histogram<string> {
  if (!chatMmLatencyMs) {
    chatMmLatencyMs = getOrCreateHistogram(
      CHAT_MM_LATENCY_HISTOGRAM_NAME,
      'Multimodal chat latency in milliseconds',
      ['modality', 'provider', 'model'],
    );
  }

  return chatMmLatencyMs;
}

const AGENT_TRACER_NAME = 'microphoenix.agent';
const MEMORY_TRACER_NAME = 'microphoenix.memory';

function recordSpanFailure(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setAttribute(GEN_AI_ERROR_TYPE, error instanceof Error ? error.name : 'Error');
  span.setStatus({ code: SpanStatusCode.ERROR });
}

export interface InvokeAgentSpanParams {
  agentName: string;
  providerName: string;
  model?: string;
  correlationId: string;
}

export interface AgentSpanUsage {
  inputTokens: number;
  outputTokens: number;
}

export async function withInvokeAgentSpan<T>(
  params: InvokeAgentSpanParams,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer(AGENT_TRACER_NAME).startActiveSpan(
    `${GEN_AI_OPERATION_INVOKE_AGENT} ${params.agentName}`,
    { kind: SpanKind.INTERNAL },
    async (span) => {
    span.setAttribute(GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_INVOKE_AGENT);
    span.setAttribute(GEN_AI_AGENT_NAME, params.agentName);
    span.setAttribute(GEN_AI_PROVIDER_NAME, params.providerName);
    span.setAttribute(AGENT_SPAN_CORRELATION_ID, params.correlationId);
    if (params.model) {
      span.setAttribute(GEN_AI_REQUEST_MODEL, params.model);
    }
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setAttribute(GEN_AI_ERROR_TYPE, error instanceof Error ? error.name : 'Error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setAgentSpanUsage(span: Span, usage: AgentSpanUsage): void {
  span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens);
  span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
}

export async function withExecuteToolSpan<T>(
  params: { toolName: string; agentName: string; correlationId: string },
  fn: () => Promise<T>,
): Promise<T> {
  return trace.getTracer(AGENT_TRACER_NAME).startActiveSpan(
    `${GEN_AI_OPERATION_EXECUTE_TOOL} ${params.toolName}`,
    { kind: SpanKind.INTERNAL },
    async (span) => {
    span.setAttribute(GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_EXECUTE_TOOL);
    span.setAttribute(GEN_AI_TOOL_NAME, params.toolName);
    span.setAttribute(GEN_AI_AGENT_NAME, params.agentName);
    span.setAttribute(AGENT_SPAN_CORRELATION_ID, params.correlationId);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setAttribute(GEN_AI_ERROR_TYPE, error instanceof Error ? error.name : 'Error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export interface CommandExecutionSpanParams {
  toolName: string;
  agentName: string;
  correlationId: string;
  /** Set only when the tool starts that process image directly. */
  executableName?: string;
}

/**
 * Command-execution refinement of execute_tool.
 * The span name adds the executable only when that name is known.
 * Command text is not an attribute.
 */
export async function withCommandExecutionSpan<T>(
  params: CommandExecutionSpanParams,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const spanName = params.executableName
    ? `${GEN_AI_OPERATION_EXECUTE_TOOL} ${params.toolName} ${params.executableName}`
    : `${GEN_AI_OPERATION_EXECUTE_TOOL} ${params.toolName}`;
  return trace.getTracer(AGENT_TRACER_NAME).startActiveSpan(
    spanName,
    { kind: SpanKind.INTERNAL },
    async (span) => {
      span.setAttribute(GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_EXECUTE_TOOL);
      span.setAttribute(GEN_AI_TOOL_NAME, params.toolName);
      span.setAttribute(GEN_AI_AGENT_NAME, params.agentName);
      span.setAttribute(AGENT_SPAN_CORRELATION_ID, params.correlationId);
      if (params.executableName) {
        span.setAttribute(PROCESS_EXECUTABLE_NAME, params.executableName);
      }
      try {
        return await fn(span);
      } catch (error) {
        recordSpanFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function markGenAiResult(span: Span, errorType?: string): void {
  if (errorType) {
    span.setAttribute(GEN_AI_ERROR_TYPE, errorType);
    span.setStatus({ code: SpanStatusCode.ERROR });
    return;
  }
  span.setStatus({ code: SpanStatusCode.OK });
}

export function recordCommandOutcome(
  span: Span,
  outcome: { exitCode: number; timedOut: boolean; failed: boolean; errorType?: string },
): void {
  span.setAttribute(PROCESS_EXIT_CODE, outcome.exitCode);
  if (outcome.timedOut) {
    span.setAttribute(GEN_AI_ERROR_TYPE, 'timeout');
    span.setStatus({ code: SpanStatusCode.ERROR });
    return;
  }
  if (outcome.failed) {
    span.setAttribute(GEN_AI_ERROR_TYPE, outcome.errorType ?? 'nonzero_exit');
    span.setStatus({ code: SpanStatusCode.ERROR });
    return;
  }
  span.setStatus({ code: SpanStatusCode.OK });
}

/** Postgres-backed search. Query text stays off the span. */
export async function withSearchMemorySpan<T extends { readonly length: number }>(
  fn: () => Promise<T>,
): Promise<T> {
  return trace.getTracer(MEMORY_TRACER_NAME).startActiveSpan(
    GEN_AI_OPERATION_SEARCH_MEMORY,
    { kind: SpanKind.CLIENT },
    async (span) => {
      span.setAttribute(GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_SEARCH_MEMORY);
      span.setAttribute(GEN_AI_MEMORY_STORE_ID, 'long_term_memories');
      try {
        const result = await fn();
        span.setAttribute(GEN_AI_MEMORY_RECORD_COUNT, result.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordSpanFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Fact creation. The caller sets the record id and any gate error on the span. */
export async function withCreateMemorySpan<T>(
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer(MEMORY_TRACER_NAME).startActiveSpan(
    GEN_AI_OPERATION_CREATE_MEMORY,
    { kind: SpanKind.CLIENT },
    async (span) => {
      span.setAttribute(GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_CREATE_MEMORY);
      span.setAttribute(GEN_AI_MEMORY_STORE_ID, 'memory_facts');
      try {
        return await fn(span);
      } catch (error) {
        recordSpanFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export async function withMcpToolCallSpan<T>(
  params: {
    toolName: string;
    sessionId: string;
    protocolVersion?: string;
    traceparent?: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  return trace.getTracer(AGENT_TRACER_NAME).startActiveSpan(
    `tools/call ${params.toolName}`,
    { kind: SpanKind.SERVER },
    async (span) => {
      span.setAttribute(MCP_METHOD_NAME, 'tools/call');
      span.setAttribute(GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_EXECUTE_TOOL);
      span.setAttribute(GEN_AI_TOOL_NAME, params.toolName);
      span.setAttribute(MCP_SESSION_ID, params.sessionId);
      span.setAttribute(MCP_PROTOCOL_VERSION, params.protocolVersion ?? '2025-11-25');
      if (params.traceparent) {
        span.setAttribute(MCP_META_TRACEPARENT, params.traceparent);
      }
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setAttribute(GEN_AI_ERROR_TYPE, error instanceof Error ? error.name : 'Error');
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// Initialize defaults eagerly (safe to call multiple times)
registerDefaultMetrics();
registerDefaultHealthChecks();