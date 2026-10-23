/**
 * MAS Runtime Core - typed MAS events facade.
 *
 * Layer: Application (business orchestration).
 *
 * MAS-A2.3 scope:
 * - define TypeScript payload types for MAS typed events;
 * - provide helper functions to emit MAS events via Application-level
 *   EventStoreService (Outbox-first, persist-then-enqueue);
 * - keep runtime contract roughly aligned with SSOT in
 *   05-PLUGIN_SYSTEM/14-typed-events-registry.md.
 *
 * NOTE:
 * - This module must not use deprecated IEventStore/IEventBus shims from
 *   src/domain/events/IEventStore.ts or src/domain/events/IEventBus.ts.
 *   See AGENTS.md for architectural rules.
 */

import type {
  MasRequest,
  MasSessionContext,
  MasTaskPlan,
  MasContextFilters,
} from '../types/mas-types';
import type { IRequestContext } from '../../context/request-context';
import type { DomainEvent } from '../../../domain/events/event-store.interface';
import { EventFactory } from '../../../domain/events/event-store.interface';
import type { EventStoreService } from '../../services/EventStoreService';
import type { DurableSloDiagnostics } from '../../../domain/mas/MasExecutionError';

import { MAS_EVENT_TOPICS, type MasEventType } from '../../../domain/mas/mas-event-topics';

export { MAS_EVENT_TOPICS, type MasEventType };

/**
 * Базовый контракт для всех MAS payload'ов.
 *
 * Требования:
 * - сериализуемый JSON-объект (без функций, Map/Set и т.п.);
 * - совместим с DomainEvent.payload (Record<string, unknown>) через индекс‑сигнатуру;
 * - не ослабляет типизацию конкретных полей payload'ов.
 */
export interface MasEventPayloadBase {
   
  [key: string]: unknown;
}

export interface MasRequestMetadata extends MasEventPayloadBase {}

export interface MasPlanMetadata extends MasEventPayloadBase {}

export interface MasExecutionErrorDetailsBag extends MasEventPayloadBase {}

export interface MasSessionStartedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  policy_evaluation_id?: string;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
  request_metadata?: MasRequestMetadata;
}

export interface MasSessionCompletedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  policy_evaluation_id?: string;
  tasks_total?: number;
  tasks_completed?: number;
  tasks_failed?: number;
  duration_seconds?: number;
  result_summary?: string | null;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
  plan_metadata?: MasPlanMetadata;
}

export interface MasSessionFailedDiagnostics {
  failure_category?: string;
  failure_source?: 'master_agent' | 'durable_recovery' | 'mixed';
  durable_error_code?: string;
  durable_status?: string;
  durable_attempts?: number;
  durable_max_attempts?: number;
  /**
   * Optional MAS runtime policy diagnostics (R2 policy layer).
   *
   * These fields are best-effort and intended for advanced analytics only.
   * They must not be used as the sole source for critical alerting.
   */
  policy_profile?: string;
  policy_source?: string;
  effective_max_non_durable_retries?: number;
  effective_max_consecutive_transient_errors_per_session?: number;
  effective_max_step_retries?: number;
  effective_task_timeout_ms?: number;
  effective_step_timeout_ms?: number;
  /**
   * Optional durable SLO diagnostics (R3-C2-C3).
   *
   * These fields describe which durable SLO profile/scope was applied and
   * the effective durable policy snapshot at the moment of failure.
   */
  slo_profile_id_input?: string;
  slo_profile_id_resolved?: string;
  durable_scope?:
    | 'tenant_scenario'
    | 'tenant_global'
    | 'scenario'
    | 'global'
    | 'baseline';
  durable_policy_snapshot?: {
    task_timeout_ms: number;
    step_timeout_ms: number;
    max_step_retries: number;
    cb_blocked_cooldown_ms: number;
    cb_blocked_max_duration_ms: number;
    cb_max_recovery_attempts: number;
  };
  /**
   * Optional structured durable SLO diagnostics object built from
   * durable_policy_debug snapshot (R3-C2-C3).
   *
   * Provides a camelCase view over the same values that are exposed via
   * durable_scope / slo_profile_id_* / durable_policy_snapshot.
   */
  durableSlo?: DurableSloDiagnostics;
  // Allow arbitrary additional diagnostics keys for forward compatibility.
  [key: string]: unknown;
}

export interface MasSessionFailedDiagnosticsInput
  extends MasEventPayloadBase {
  failure_category?: string;
  failure_source?: 'master_agent' | 'durable_recovery' | 'mixed';
}

export interface MasTaskFailureDiagnostics extends MasEventPayloadBase {
  durableSlo?: DurableSloDiagnostics;
}

export interface MasTaskPlanFailureDiagnostics extends MasEventPayloadBase {}

export interface AgentStatusDetails extends MasEventPayloadBase {}

export interface MasSessionFailedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  policy_evaluation_id?: string;
  failure_stage: 'decomposition' | 'execution' | 'unknown';
  error_name?: string;
  error_message?: string;
  is_decomposition_error?: boolean;
  duration_seconds?: number;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
  diagnostics?: MasSessionFailedDiagnostics;
}

export interface MasTaskPlanCreatedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  tasks_total: number;
  entry_task_ids?: string[];
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
  plan_metadata?: MasPlanMetadata;
}

export interface MasTaskPlanFailedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  error_name?: string;
  error_message?: string;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
  diagnostics?: MasTaskPlanFailureDiagnostics;
}

export interface MasSessionMemoryFinalizedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  tenant_id: string;
  session_id: string;
  reason?: string;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
}

export interface MasSessionMemoryFinalizationFailedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  tenant_id: string;
  session_id: string;
  reason?: string;
  error_name?: string;
  error_message?: string;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
}

export interface MasMemoryContextUsedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  scenario?: string;
  use_case?: string;
  tenant_id: string;
  user_id?: string;
  session_id: string;
  messages_returned: number;
  knowledge_snippets_returned: number;
  governance_status?: 'ok' | 'deny' | 'allow_with_modifications' | 'unknown';
  applied_limits?: {
    max_messages?: number;
    max_tokens?: number;
  };
  filters?: MasContextFilters;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
}

const MAS_MEMORY_CONTEXT_USED_TOPIC = 'mas.memory.context_used' as const;

/**
 * MAS task lifecycle events.
 * These are generic enough to be reused by different execution strategies.
 */
export interface MasTaskStartedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  task_id: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  task_type?: string;
  agent_id?: string;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
}

export interface MasTaskCompletedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  task_id: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  task_type?: string;
  agent_id?: string;
  duration_seconds?: number;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
}

export interface MasTaskFailedEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  mas_trace_id?: string;
  task_id: string;
  scenario: string;
  use_case?: string;
  tenant_id?: string;
  user_id?: string;
  task_type?: string;
  agent_id?: string;
  duration_seconds?: number;
  error_type: string;
  error_message?: string;
  timestamp: string;
  correlation_id: string;
  correlation_source?: string;
  /**
   * Optional durable SLO diagnostics derived from MasExecutionError.details.
   *
   * R3-C2-C3: mirrors DurableSloDiagnostics used in mas.session.failed
   * diagnostics but scoped to a single MAS task failure.
   */
  diagnostics?: MasTaskFailureDiagnostics;
}

/**
 * Agent-level observability events in MAS context.
 */
export type AgentStatusValue = 'idle' | 'running' | 'failed' | 'completed';

export interface AgentStatusEventPayload extends MasEventPayloadBase {
  agent_id: string;
  mas_session_id?: string;
  status: AgentStatusValue;
  timestamp: string;
  correlation_id: string;
  details?: AgentStatusDetails;
}

export interface AgentHandoffEventPayload extends MasEventPayloadBase {
  from_agent_id: string;
  to_agent_id: string;
  mas_session_id: string;
  reason?: string;
  timestamp: string;
  correlation_id: string;
}

export interface AgentConflictEventPayload extends MasEventPayloadBase {
  mas_session_id: string;
  agent_ids: string[];
  conflict_type: string;
  details?: string;
  timestamp: string;
  correlation_id: string;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(value);
}

function isDurableScope(
  value: unknown,
): value is NonNullable<MasSessionFailedDiagnostics['durable_scope']> {
  return (
    value === 'tenant_scenario' ||
    value === 'tenant_global' ||
    value === 'scenario' ||
    value === 'global' ||
    value === 'baseline'
  );
}

function toDurableScope(
  value: unknown,
): MasSessionFailedDiagnostics['durable_scope'] | undefined {
  return isDurableScope(value) ? value : undefined;
}

function extractPolicyEvaluationId(
  session: MasSessionContext,
): string | undefined {
  const metadata = session.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const bag = metadata;
  const raw =
    bag.lastPolicyEvaluationId ??
    bag.policyEvaluationId;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildMasSessionFailedDiagnostics(
  error: unknown,
  diagnostics?: MasSessionFailedDiagnosticsInput,
): MasSessionFailedDiagnostics | undefined {
  const hasBaseDiagnostics =
    diagnostics && typeof diagnostics === 'object';
  const base = hasBaseDiagnostics
    ? { ...(diagnostics as MasSessionFailedDiagnostics) }
    : undefined;

  const errorHasDetails =
    error &&
    typeof error === 'object' &&
    (error as { details?: unknown }).details &&
    typeof (error as { details?: unknown }).details === 'object';

  if (!errorHasDetails) {
    return base;
  }

  const details = (error as { details: MasExecutionErrorDetailsBag }).details;
  const result: MasSessionFailedDiagnostics = { ...(base ?? {}) };
  let hasNewFields = false;

  if (
    result.failure_category === undefined &&
    typeof details.masErrorCategory === 'string'
  ) {
    result.failure_category = details.masErrorCategory;
    hasNewFields = true;
  }

  let errorCode: string | undefined;
  if (error && typeof error === 'object' && 'code' in error) {
    const candidate = (error as { code?: unknown }).code;
    if (typeof candidate === 'string') {
      errorCode = candidate;
    }
  }

  if (result.durable_error_code === undefined && errorCode) {
    result.durable_error_code = errorCode;
    hasNewFields = true;
  }

  const status = details.durable_status ?? details.status;
  if (result.durable_status === undefined && typeof status === 'string') {
    result.durable_status = status;
    hasNewFields = true;
  }

  const attempts = details.attempts;
  if (result.durable_attempts === undefined && typeof attempts === 'number') {
    result.durable_attempts = attempts;
    hasNewFields = true;
  }

  const maxAttempts = details.maxAttempts ??
    details.effective_max_step_retries;
  if (
    result.durable_max_attempts === undefined &&
    typeof maxAttempts === 'number'
  ) {
    result.durable_max_attempts = maxAttempts;
    hasNewFields = true;
  }

  const effectiveNonDurableRetries =
    details.effective_max_non_durable_retries;
  if (
    result.effective_max_non_durable_retries === undefined &&
    typeof effectiveNonDurableRetries === 'number'
  ) {
    result.effective_max_non_durable_retries = effectiveNonDurableRetries;
    hasNewFields = true;
  }

  const effectiveMaxConsecutiveTransientErrors =
    details.effective_max_consecutive_transient_errors_per_session;
  if (
    result.effective_max_consecutive_transient_errors_per_session ===
      undefined &&
    typeof effectiveMaxConsecutiveTransientErrors === 'number'
  ) {
    result.effective_max_consecutive_transient_errors_per_session =
      effectiveMaxConsecutiveTransientErrors;
    hasNewFields = true;
  }

  const durableScope = toDurableScope(details.durable_scope);
  if (result.durable_scope === undefined && durableScope !== undefined) {
    result.durable_scope = durableScope;
    hasNewFields = true;
  }

  const sloProfileInput = details.slo_profile_id_input;
  if (
    result.slo_profile_id_input === undefined &&
    typeof sloProfileInput === 'string'
  ) {
    result.slo_profile_id_input = sloProfileInput;
    hasNewFields = true;
  }

  const sloProfileResolved = details.slo_profile_id_resolved;
  if (
    result.slo_profile_id_resolved === undefined &&
    typeof sloProfileResolved === 'string'
  ) {
    result.slo_profile_id_resolved = sloProfileResolved;
    hasNewFields = true;
  }

  const policySource = details.policy_source;
  if (result.policy_source === undefined && typeof policySource === 'string') {
    result.policy_source = policySource;
    hasNewFields = true;
  }

  const effectiveTaskTimeout = details.effective_task_timeout_ms;
  const effectiveStepTimeout = details.effective_step_timeout_ms;
  const effectiveMaxStepRetries =
    details.effective_max_step_retries;
  const effectiveCbCooldown =
    details.effective_cb_blocked_cooldown_ms;
  const effectiveCbMaxDuration =
    details.effective_cb_blocked_max_duration_ms;
  const effectiveCbMaxRecovery =
    details.effective_cb_max_recovery_attempts;

  if (
    result.effective_task_timeout_ms === undefined &&
    typeof effectiveTaskTimeout === 'number'
  ) {
    result.effective_task_timeout_ms = effectiveTaskTimeout;
    hasNewFields = true;
  }

  if (
    result.effective_step_timeout_ms === undefined &&
    typeof effectiveStepTimeout === 'number'
  ) {
    result.effective_step_timeout_ms = effectiveStepTimeout;
    hasNewFields = true;
  }

  if (
    result.effective_max_step_retries === undefined &&
    typeof effectiveMaxStepRetries === 'number'
  ) {
    result.effective_max_step_retries = effectiveMaxStepRetries;
    hasNewFields = true;
  }

  const hasFullSnapshot =
    typeof effectiveTaskTimeout === 'number' &&
    typeof effectiveStepTimeout === 'number' &&
    typeof effectiveMaxStepRetries === 'number' &&
    typeof effectiveCbCooldown === 'number' &&
    typeof effectiveCbMaxDuration === 'number' &&
    typeof effectiveCbMaxRecovery === 'number';

  if (!result.durable_policy_snapshot && hasFullSnapshot) {
    result.durable_policy_snapshot = {
      task_timeout_ms: effectiveTaskTimeout,
      step_timeout_ms: effectiveStepTimeout,
      max_step_retries: effectiveMaxStepRetries,
      cb_blocked_cooldown_ms: effectiveCbCooldown,
      cb_blocked_max_duration_ms: effectiveCbMaxDuration,
      cb_max_recovery_attempts: effectiveCbMaxRecovery,
    };
    hasNewFields = true;
  }
  // Fallback: reconstruct DurableSloDiagnostics from flattened fields and snapshot.
  if (!result.durableSlo) {
    const rawScope = toDurableScope(details.durable_scope);
    const sloInputRaw = details.slo_profile_id_input;
    const sloResolvedRaw = details.slo_profile_id_resolved;

    const snapshotFromDetails =
      (result.durable_policy_snapshot as
        | {
            task_timeout_ms?: unknown;
            step_timeout_ms?: unknown;
            max_step_retries?: unknown;
            cb_blocked_cooldown_ms?: unknown;
            cb_blocked_max_duration_ms?: unknown;
            cb_max_recovery_attempts?: unknown;
          }
        | undefined) ??
      (details.durable_policy_snapshot as
        | {
            task_timeout_ms?: unknown;
            step_timeout_ms?: unknown;
            max_step_retries?: unknown;
            cb_blocked_cooldown_ms?: unknown;
            cb_blocked_max_duration_ms?: unknown;
            cb_max_recovery_attempts?: unknown;
          }
        | undefined);

    if (rawScope !== undefined) {
      const normalized: DurableSloDiagnostics = {
        durableScope: rawScope,
      };

      if (typeof sloInputRaw === 'string') {
        normalized.sloProfileIdInput = sloInputRaw;
      }
      if (typeof sloResolvedRaw === 'string') {
        normalized.sloProfileIdResolved = sloResolvedRaw;
      }

      if (snapshotFromDetails && typeof snapshotFromDetails === 'object') {
        const tt = snapshotFromDetails.task_timeout_ms;
        const st = snapshotFromDetails.step_timeout_ms;
        const mr = snapshotFromDetails.max_step_retries;
        const cbCool = snapshotFromDetails.cb_blocked_cooldown_ms;
        const cbMaxDur = snapshotFromDetails.cb_blocked_max_duration_ms;
        const cbMaxRec = snapshotFromDetails.cb_max_recovery_attempts;

        if (typeof tt === 'number') {
          normalized.effectiveTaskTimeoutMs = tt;
        }
        if (typeof st === 'number') {
          normalized.effectiveStepTimeoutMs = st;
        }
        if (typeof mr === 'number') {
          normalized.effectiveMaxStepRetries = mr;
        }
        if (typeof cbCool === 'number') {
          normalized.effectiveCbBlockedCooldownMs = cbCool;
        }
        if (typeof cbMaxDur === 'number') {
          normalized.effectiveCbBlockedMaxDurationMs = cbMaxDur;
        }
        if (typeof cbMaxRec === 'number') {
          normalized.effectiveCbMaxRecoveryAttempts = cbMaxRec;
        }
      }

      result.durableSlo = normalized;
      hasNewFields = true;
    }
  }

  if (!hasNewFields && !base) {
    return undefined;
  }

  return result;
}
 
async function persistMasEvents(
  events: DomainEvent[],
  eventStoreService?: EventStoreService,
): Promise<void> {
  // MAS events must be best-effort and must never break business logic.
  if (!eventStoreService) {
    return;
  }
  try {
    await eventStoreService.saveDomainEvents(events);
  } catch {
    // Intentionally swallow all errors (including DI misconfiguration).
  }
}

export async function emitMasSessionStarted(params: {
  session: MasSessionContext;
  scenario: string;
  useCase?: string;
  requestContext: IRequestContext;
  requestMetadata?: MasRequestMetadata;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const { session, scenario, useCase, requestContext, requestMetadata, eventStoreService } = params;
  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const payload: MasSessionStartedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      scenario,
      use_case: useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      policy_evaluation_id: extractPolicyEvaluationId(session),
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
      request_metadata: requestMetadata,
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.session.started',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitMasSessionCompleted(params: {
  session: MasSessionContext;
  scenario: string;
  useCase?: string;
  durationSeconds?: number;
  resultSummary?: string | null;
  plan?: MasTaskPlan;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const {
    session,
    scenario,
    useCase,
    durationSeconds,
    resultSummary,
    plan,
    requestContext,
    eventStoreService,
  } = params;
  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );
    const tasksTotal = plan?.tasks.length;
    const tasksCompleted = plan
      ? plan.tasks.filter((t) => t.status === 'completed').length
      : undefined;
    const tasksFailed = plan
      ? plan.tasks.filter((t) => t.status === 'failed').length
      : undefined;

    const payload: MasSessionCompletedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      scenario,
      use_case: useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      policy_evaluation_id: extractPolicyEvaluationId(session),
      tasks_total: tasksTotal,
      tasks_completed: tasksCompleted,
      tasks_failed: tasksFailed,
      duration_seconds: durationSeconds,
      result_summary: resultSummary === undefined ? undefined : resultSummary,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
      plan_metadata: plan?.metadata,
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.session.completed',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitMasSessionFailed(params: {
  session: MasSessionContext;
  scenario: string;
  useCase?: string;
  durationSeconds?: number;
  error: unknown;
  failureStage?: 'decomposition' | 'execution' | 'unknown';
  diagnostics?: MasSessionFailedDiagnosticsInput;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const {
    session,
    scenario,
    useCase,
    durationSeconds,
    error,
    failureStage = 'unknown',
    diagnostics,
    requestContext,
    eventStoreService,
  } = params;
  try {
    const asError = error instanceof Error ? error : undefined;
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const diagnosticsPayload = buildMasSessionFailedDiagnostics(
      error,
      diagnostics,
    );

    const payload: MasSessionFailedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      scenario,
      use_case: useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      policy_evaluation_id: extractPolicyEvaluationId(session),
      failure_stage: failureStage,
      error_name: asError?.name,
      error_message: asError?.message ?? (error ? String(error) : undefined),
      is_decomposition_error: failureStage === 'decomposition',
      duration_seconds: durationSeconds,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
      diagnostics: diagnosticsPayload,
    };
 
    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.session.failed',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitMasTaskPlanCreated(params: {
  session: MasSessionContext;
  request: MasRequest;
  plan: MasTaskPlan;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const { session, request, plan, eventStoreService } = params;
  try {
    const payload: MasTaskPlanCreatedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      scenario: request.scenario,
      use_case: request.useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      tasks_total: plan.tasks.length,
      entry_task_ids: plan.entryTaskIds.map((id) => String(id)),
      timestamp: new Date().toISOString(),
      correlation_id: String(session.correlationId),
      correlation_source: 'mas_context',
      plan_metadata: plan.metadata,
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.task.plan_created',
      payload,
      String(session.correlationId),
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitMasTaskPlanFailed(params: {
  session: MasSessionContext;
  request: MasRequest;
  error: unknown;
  diagnostics?: MasTaskPlanFailureDiagnostics;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const { session, request, error, diagnostics, eventStoreService } = params;
  try {
    const asError = error instanceof Error ? error : undefined;

    const payload: MasTaskPlanFailedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      scenario: request.scenario,
      use_case: request.useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      error_name: asError?.name,
      error_message: asError?.message ?? (error ? String(error) : undefined),
      timestamp: new Date().toISOString(),
      correlation_id: String(session.correlationId),
      correlation_source: 'mas_context',
      diagnostics,
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.task.plan_failed',
      payload,
      String(session.correlationId),
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}
/**
 * Per-task MAS lifecycle events (started/completed/failed).
 * These helpers are currently not wired into MasterAgent execution flows,
 * but are ready for future integration.
 */
export async function emitMasTaskStarted(params: {
  session: MasSessionContext;
  taskId: string;
  scenario: string;
  useCase?: string;
  taskType?: string;
  agentId?: string;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const {
    session,
    taskId,
    scenario,
    useCase,
    taskType,
    agentId,
    requestContext,
    eventStoreService,
  } = params;

  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const payload: MasTaskStartedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      task_id: String(taskId),
      scenario,
      use_case: useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      task_type: taskType,
      agent_id: agentId,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.task.started',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitMasTaskCompleted(params: {
  session: MasSessionContext;
  taskId: string;
  scenario: string;
  useCase?: string;
  taskType?: string;
  agentId?: string;
  durationSeconds?: number;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const {
    session,
    taskId,
    scenario,
    useCase,
    taskType,
    agentId,
    durationSeconds,
    requestContext,
    eventStoreService,
  } = params;

  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const payload: MasTaskCompletedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      task_id: String(taskId),
      scenario,
      use_case: useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      task_type: taskType,
      agent_id: agentId,
      duration_seconds: durationSeconds,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.task.completed',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitMasTaskFailed(params: {
  session: MasSessionContext;
  taskId: string;
  scenario: string;
  useCase?: string;
  taskType?: string;
  agentId?: string;
  durationSeconds?: number;
  error: unknown;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const {
    session,
    taskId,
    scenario,
    useCase,
    taskType,
    agentId,
    durationSeconds,
    error,
    requestContext,
    eventStoreService,
  } = params;

  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );
    const asError = error instanceof Error ? error : undefined;

    const durableDiagnostics = buildMasSessionFailedDiagnostics(error, undefined);

    const payload: MasTaskFailedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      task_id: String(taskId),
      scenario,
      use_case: useCase,
      tenant_id: toStringOrUndefined(session.tenantId),
      user_id: toStringOrUndefined(session.userId),
      task_type: taskType,
      agent_id: agentId,
      duration_seconds: durationSeconds,
      error_type: asError?.name ?? 'UnknownError',
      error_message: asError?.message ?? (error ? String(error) : undefined),
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
    };

    if (durableDiagnostics?.durableSlo) {
      payload.diagnostics = {
        durableSlo: durableDiagnostics.durableSlo,
      };
    }

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.task.failed',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

/**
 * Agent-level MAS events (status, handoff, conflict).
 * These are emitted per-agent and are independent from MAS HTTP API.
 */
export async function emitAgentStatus(params: {
  agentId: string;
  status: AgentStatusValue;
  session?: MasSessionContext;
  requestContext: IRequestContext;
  details?: AgentStatusDetails;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const { agentId, status, session, requestContext, details, eventStoreService } =
    params;

  try {
    const correlationId = String(requestContext.getCorrelationId());

    const payload: AgentStatusEventPayload = {
      agent_id: String(agentId),
      mas_session_id: session ? String(session.masSessionId) : undefined,
      status,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      details,
    };

    const aggregateId = session ? String(session.masSessionId) : String(agentId);

    const event = EventFactory.createBaseEvent(
      aggregateId,
      'agent.status',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitAgentHandoff(params: {
  fromAgentId: string;
  toAgentId: string;
  session: MasSessionContext;
  reason?: string;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const { fromAgentId, toAgentId, session, reason, requestContext, eventStoreService } =
    params;

  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const payload: AgentHandoffEventPayload = {
      from_agent_id: String(fromAgentId),
      to_agent_id: String(toAgentId),
      mas_session_id: String(session.masSessionId),
      reason,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'agent.handoff',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitAgentConflict(params: {
  session: MasSessionContext;
  agentIds: string[];
  conflictType: string;
  details?: string;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const { session, agentIds, conflictType, details, requestContext, eventStoreService } =
    params;

  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const payload: AgentConflictEventPayload = {
      mas_session_id: String(session.masSessionId),
      agent_ids: agentIds.map((id) => String(id)),
      conflict_type: conflictType,
      details,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'agent.conflict',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}


export async function emitMasMemoryContextUsed(params: {
  aggregateId: string;
  payload: MasMemoryContextUsedEventPayload;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  try {
    const { eventStoreService } = params;
    if (!eventStoreService) {
      return;
    }
    const payload: MasMemoryContextUsedEventPayload = {
      ...params.payload,
      correlation_source: 'mas_context',
    };
    const event = EventFactory.createBaseEvent(
      params.aggregateId,
      MAS_MEMORY_CONTEXT_USED_TOPIC,
      payload,
      payload.correlation_id,
    );
    await eventStoreService.saveDomainEvents([event]);
  } catch {
    // MAS ⇄ Memory observability events must be best-effort and must never
    // break MAS Runtime business logic.
  }
}

export async function emitMasSessionMemoryFinalized(params: {
  session: MasSessionContext;
  tenantId: string;
  sessionId: string;
  reason?: string;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const { session, tenantId, sessionId, reason, requestContext, eventStoreService } =
    params;
  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const payload: MasSessionMemoryFinalizedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      tenant_id: tenantId,
      session_id: sessionId,
      reason,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.session.memory_finalized',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}

export async function emitMasSessionMemoryFinalizationFailed(params: {
  session: MasSessionContext;
  tenantId: string;
  sessionId: string;
  reason?: string;
  error: unknown;
  requestContext: IRequestContext;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  const {
    session,
    tenantId,
    sessionId,
    reason,
    error,
    requestContext,
    eventStoreService,
  } = params;
  try {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );
    const asError = error instanceof Error ? error : undefined;

    const payload: MasSessionMemoryFinalizationFailedEventPayload = {
      mas_session_id: String(session.masSessionId),
      mas_trace_id: toStringOrUndefined(session.masTraceId),
      tenant_id: tenantId,
      session_id: sessionId,
      reason,
      error_name: asError?.name,
      error_message: asError?.message ?? (error ? String(error) : undefined),
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      correlation_source: 'mas_context',
    };

    const event = EventFactory.createBaseEvent(
      String(session.masSessionId),
      'mas.session.memory_finalization_failed',
      payload,
      correlationId,
    );

    await persistMasEvents([event], eventStoreService);
  } catch {
    // best-effort
  }
}
