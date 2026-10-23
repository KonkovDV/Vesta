import {
  getOrCreateCounter,
  getOrCreateHistogram,
} from './registry';

export type MasOrchestrationOutcome =
  | 'success'
  | 'error'
  | 'decomposition_error';

export type MasOperationOutcome = 'success' | 'error';

export type MasMemoryWriteOperation =
  | 'append_messages'
  | 'finalize_session';

export type MasMemoryErrorOperation =
  | 'get_context_window'
  | 'append_messages'
  | 'consolidate_session'
  | 'end_session'
  | 'finalize_session'
  | 'session_state_load'
  | 'session_state_save'
  | 'session_state_delete';

export type MasMemoryErrorBackend =
  | 'legacy'
  | 'openmemory'
  | 'dualwrite'
  | 'unknown';

export type MasSessionCounterOutcome = 'started' | 'completed' | 'failed';

export type MasSessionDurationOutcome = 'completed' | 'failed';

export type MasTaskCounterOutcome = 'started' | 'completed' | 'failed';

export type MasTaskDurationOutcome = 'completed' | 'failed';

export type MasAgentRequestOutcome = 'success' | 'error';

export type MasErrorComponent =
  | 'master_agent'
  | 'context_coordinator'
  | 'task_decomposer'
  | 'agent'
  | 'durable_execution'
  | 'durable_recovery'
  | 'other';

export type DurableScopeLabel =
  | 'tenant_scenario'
  | 'tenant_global'
  | 'scenario'
  | 'global'
  | 'baseline';

// --- Core MAS session / task / agent metrics ---

const masSessionsTotal = getOrCreateCounter(
  'mas_sessions_total',
  'Total number of MAS sessions by outcome',
  ['scenario', 'outcome'],
);

const masSessionDurationSeconds = getOrCreateHistogram(
  'mas_session_duration_seconds',
  'Duration of MAS sessions in seconds',
  ['scenario', 'outcome'],
);

const masTasksTotal = getOrCreateCounter(
  'mas_tasks_total',
  'Total number of MAS tasks by outcome',
  ['scenario', 'task_type', 'outcome'],
);

const masTaskDurationSeconds = getOrCreateHistogram(
  'mas_task_duration_seconds',
  'Duration of MAS tasks in seconds',
  ['scenario', 'task_type', 'outcome'],
);

const masAgentRequestsTotal = getOrCreateCounter(
  'mas_agent_requests_total',
  'Total number of MAS agent requests by outcome',
  ['agent', 'strategy', 'outcome'],
);

const masAgentRequestDurationSeconds = getOrCreateHistogram(
  'mas_agent_request_duration_seconds',
  'Duration of MAS agent requests in seconds',
  ['agent', 'strategy', 'outcome'],
);

const masErrorsTotal = getOrCreateCounter(
  'mas_errors_total',
  'Total number of MAS errors by component',
  ['component', 'error_type'],
);

const masDurableSloProfileAppliedTotal = getOrCreateCounter(
  'mas_durable_slo_profile_applied_total',
  'Total number of durable SLO profiles applied by scope',
  ['durable_scope', 'slo_profile_id'],
);

const masDurableSloPolicyFallbackTotal = getOrCreateCounter(
  'mas_durable_slo_policy_fallback_total',
  'Total number of durable SLO policy fallbacks by reason, key and scope',
  ['reason', 'policy_key', 'durable_scope'],
);

const masDurableEffectiveTaskTimeoutSeconds = getOrCreateHistogram(
  'mas_durable_effective_task_timeout_seconds',
  'Distribution of effective durable task timeout values in seconds by scope',
  ['durable_scope'],
  [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400],
);

const masDurableEffectiveStepTimeoutSeconds = getOrCreateHistogram(
  'mas_durable_effective_step_timeout_seconds',
  'Distribution of effective durable step timeout values in seconds by scope',
  ['durable_scope'],
  [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600],
);

const masDurableEffectiveMaxStepRetries = getOrCreateHistogram(
  'mas_durable_effective_max_step_retries',
  'Distribution of effective durable max step retry attempts by scope',
  ['durable_scope'],
  [0, 1, 2, 3, 4, 5, 7, 10],
);

// --- Existing orchestration / context-window / memory-write metrics ---

const masOrchestrationsTotal = getOrCreateCounter(
  'mas_orchestrations_total',
  'Total MAS orchestrations executed by MasterAgent',
  ['scenario', 'use_case', 'outcome', 'mas_session_id', 'tenant_id', 'user_id', 'mas_flow_type'],
);

const masOrchestrationDurationSeconds = getOrCreateHistogram(
  'mas_orchestration_duration_seconds',
  'Duration of MAS orchestrations in seconds',
  ['scenario', 'use_case', 'outcome', 'mas_session_id', 'tenant_id', 'user_id', 'mas_flow_type'],
);

const masContextWindowRequestsTotal = getOrCreateCounter(
  'mas_context_window_requests_total',
  'Total number of MAS context window retrieval operations',
  ['outcome'],
);

const masContextWindowDurationSeconds = getOrCreateHistogram(
  'mas_context_window_duration_seconds',
  'Duration of MAS context window retrieval operations in seconds',
  ['outcome'],
);

const masContextPruningsTotal = getOrCreateCounter(
  'mas_context_prunings_total',
  'Total number of MAS context pruning operations',
  ['scenario', 'result'],
);

const masContextTokensPrunedTotal = getOrCreateCounter(
  'mas_context_tokens_pruned_total',
  'Total number of tokens removed by MAS context pruning (approximate)',
  ['scenario'],
);

const masContextMessagesPrunedTotal = getOrCreateCounter(
  'mas_context_messages_pruned_total',
  'Total number of messages removed by MAS context pruning',
  ['scenario'],
);

const masMemoryWritesTotal = getOrCreateCounter(
  'mas_memory_writes_total',
  'Total number of MAS memory write operations',
  ['operation', 'outcome'],
);

const masMemoryErrorsTotal = getOrCreateCounter(
  'mas_memory_errors_total',
  'Total number of MAS-visible memory errors by operation and backend',
  ['operation', 'backend'],
);

function normalizeScenario(scenario: string | undefined): string {
  if (!scenario) return '__unknown__';
  const trimmed = scenario.trim();
  if (!trimmed) return '__unknown__';
  return trimmed.slice(0, 100);
}

function normalizeUseCase(useCase: string | undefined): string {
  if (!useCase) return '__none__';
  const trimmed = useCase.trim();
  if (!trimmed) return '__none__';
  return trimmed.slice(0, 100);
}

function normalizeOptionalLabel(
  value: string | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 100);
}

function normalizeErrorType(errorType: string | undefined): string {
  return normalizeOptionalLabel(errorType, 'unknown');
}

export type DurableSloFallbackReason =
  | 'invalid_json'
  | 'invalid_type'
  | 'invalid_type_after_parse'
  | 'not_a_number'
  | 'out_of_range'
  | 'unknown_slo_profile_id'
  | 'no_config'
  | 'failed_to_parse_tenants'
  | 'invalid_slo_profile_type';

function normalizeDurableScope(
  scope: DurableScopeLabel | undefined,
): DurableScopeLabel {
  if (!scope) return 'baseline';
  return scope;
}

function normalizeFallbackReason(
  reason: DurableSloFallbackReason,
): DurableSloFallbackReason {
  return reason;
}

export function recordDurableSloProfileApplied(params: {
  durableScope: DurableScopeLabel;
  sloProfileId: string;
}): void {
  try {
    const scope = normalizeDurableScope(params.durableScope);
    const profileId = normalizeOptionalLabel(
      params.sloProfileId,
      '__baseline__',
    );
    masDurableSloProfileAppliedTotal.inc({
      durable_scope: scope,
      slo_profile_id: profileId,
    });
  } catch {
    // Metrics must never break MAS business logic
  }
}

export function recordDurableSloPolicyFallback(params: {
  reason: DurableSloFallbackReason;
  policyKey: string;
  durableScope?: DurableScopeLabel;
}): void {
  try {
    const scope = normalizeDurableScope(params.durableScope);
    const reason = normalizeFallbackReason(params.reason);
    const policyKey = normalizeOptionalLabel(params.policyKey, 'durable');

    masDurableSloPolicyFallbackTotal.inc({
      reason,
      policy_key: policyKey,
      durable_scope: scope,
    });
  } catch {
    // Metrics must never break MAS business logic
  }
}

export function observeDurableEffectivePolicy(params: {
  durableScope: DurableScopeLabel;
  policySnapshot: {
    effective_task_timeout_ms: number;
    effective_step_timeout_ms: number;
    effective_max_step_retries: number;
  };
}): void {
  try {
    const scope = normalizeDurableScope(params.durableScope);
    const taskTimeoutSeconds =
      params.policySnapshot.effective_task_timeout_ms / 1000;
    const stepTimeoutSeconds =
      params.policySnapshot.effective_step_timeout_ms / 1000;
    const maxStepRetries = params.policySnapshot.effective_max_step_retries;

    masDurableEffectiveTaskTimeoutSeconds.observe(
      { durable_scope: scope },
      taskTimeoutSeconds,
    );
    masDurableEffectiveStepTimeoutSeconds.observe(
      { durable_scope: scope },
      stepTimeoutSeconds,
    );
    masDurableEffectiveMaxStepRetries.observe(
      { durable_scope: scope },
      maxStepRetries,
    );
  } catch {
    // Metrics must never break MAS business logic
  }
}

// --- Public helpers: MAS sessions ---

export function incrementMasSessionsTotal(input: {
  scenario?: string;
  outcome: MasSessionCounterOutcome;
}): void {
  try {
    masSessionsTotal.inc({
      scenario: normalizeScenario(input.scenario),
      outcome: input.outcome,
    });
  } catch {
    // Metrics must never break MAS business logic
  }
}

export function recordMasSessionDuration(input: {
  scenario?: string;
  outcome: MasSessionDurationOutcome;
  durationSeconds: number;
}): void {
  try {
    const labels = {
      scenario: normalizeScenario(input.scenario),
      outcome: input.outcome,
    };

    masSessionDurationSeconds.observe(labels, input.durationSeconds);
  } catch {
    // Metrics must never break MAS business logic
  }
}

// --- Public helpers: MAS tasks ---

export function incrementMasTasksTotal(input: {
  scenario?: string;
  taskType?: string;
  outcome: MasTaskCounterOutcome;
}): void {
  try {
    masTasksTotal.inc({
      scenario: normalizeScenario(input.scenario),
      task_type: normalizeOptionalLabel(input.taskType, '__unknown__'),
      outcome: input.outcome,
    });
  } catch {
    // ignore
  }
}

export function recordMasTaskDuration(input: {
  scenario?: string;
  taskType?: string;
  outcome: MasTaskDurationOutcome;
  durationSeconds: number;
}): void {
  try {
    const labels = {
      scenario: normalizeScenario(input.scenario),
      task_type: normalizeOptionalLabel(input.taskType, '__unknown__'),
      outcome: input.outcome,
    };

    masTaskDurationSeconds.observe(labels, input.durationSeconds);
  } catch {
    // ignore
  }
}

// --- Public helpers: MAS agent requests ---

export function incrementMasAgentRequestsTotal(input: {
  agent?: string;
  outcome: MasAgentRequestOutcome;
  strategy?: string;
}): void {
  try {
    masAgentRequestsTotal.inc({
      agent: normalizeOptionalLabel(input.agent, '__unknown__'),
      strategy: normalizeOptionalLabel(input.strategy, '__none__'),
      outcome: input.outcome,
    });
  } catch {
    // ignore
  }
}

export function recordMasAgentRequestDuration(input: {
  agent?: string;
  outcome: MasAgentRequestOutcome;
  strategy?: string;
  durationSeconds: number;
}): void {
  try {
    const labels = {
      agent: normalizeOptionalLabel(input.agent, '__unknown__'),
      strategy: normalizeOptionalLabel(input.strategy, '__none__'),
      outcome: input.outcome,
    };

    masAgentRequestDurationSeconds.observe(labels, input.durationSeconds);
  } catch {
    // ignore
  }
}

// --- Public helpers: MAS errors ---

export function incrementMasErrorsTotal(input: {
  component: MasErrorComponent;
  errorType?: string;
}): void {
  try {
    masErrorsTotal.inc({
      component: input.component,
      error_type: normalizeErrorType(input.errorType),
    });
  } catch {
    // ignore
  }
}

export function incrementMasMemoryErrorsTotal(input: {
  operation: MasMemoryErrorOperation;
  backend?: MasMemoryErrorBackend;
}): void {
  try {
    masMemoryErrorsTotal.inc({
      operation: input.operation,
      backend: input.backend ?? 'unknown',
    });
  } catch {
    // ignore
  }
}

// --- Existing helpers for orchestration and context coordinator flows ---

export function recordMasOrchestration(input: {
  scenario: string | undefined;
  useCase?: string;
  outcome: MasOrchestrationOutcome;
  durationSeconds: number;
  masSessionId?: string;
  tenantId?: string;
  userId?: string;
  masFlowType?: string;
}): void {
  try {
    const labels = {
      scenario: normalizeScenario(input.scenario),
      use_case: normalizeUseCase(input.useCase),
      outcome: input.outcome,
      mas_session_id: normalizeOptionalLabel(input.masSessionId, '__none__'),
      tenant_id: normalizeOptionalLabel(input.tenantId, '__none__'),
      user_id: normalizeOptionalLabel(input.userId, '__none__'),
      mas_flow_type: normalizeOptionalLabel(input.masFlowType, '__default__'),
    };

    masOrchestrationsTotal.inc(labels);
    masOrchestrationDurationSeconds.observe(labels, input.durationSeconds);
  } catch {
    // Metrics must never break MAS business logic
  }
}

export function incrementMasContextWindowRequests(input: {
  outcome: MasOperationOutcome;
}): void {
  try {
    masContextWindowRequestsTotal.inc({
      outcome: input.outcome,
    });
  } catch {
    // ignore
  }
}

export function recordMasContextWindowDuration(input: {
  outcome: MasOperationOutcome;
  durationSeconds: number;
}): void {
  try {
    masContextWindowDurationSeconds.observe(
      { outcome: input.outcome },
      input.durationSeconds,
    );
  } catch {
    // ignore
  }
}

export function incrementMasMemoryWrite(input: {
  operation: MasMemoryWriteOperation;
  outcome: MasOperationOutcome;
}): void {
  try {
    masMemoryWritesTotal.inc({
      operation: input.operation,
      outcome: input.outcome,
    });
  } catch {
    // ignore
  }
}

export function recordMasContextPruning(input: {
  scenario?: string;
  result: 'pruned' | 'skipped';
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
}): void {
  try {
    const scenarioLabel = normalizeScenario(input.scenario);

    masContextPruningsTotal.inc({
      scenario: scenarioLabel,
      result: input.result,
    });

    if (input.result === 'pruned') {
      const tokensSaved = Math.max(0, input.tokensBefore - input.tokensAfter);
      const messagesRemoved = Math.max(
        0,
        input.messagesBefore - input.messagesAfter,
      );

      if (tokensSaved > 0) {
        masContextTokensPrunedTotal.inc(
          {
            scenario: scenarioLabel,
          },
          tokensSaved,
        );
      }

      if (messagesRemoved > 0) {
        masContextMessagesPrunedTotal.inc(
          {
            scenario: scenarioLabel,
          },
          messagesRemoved,
        );
      }
    }
  } catch {
    // ignore
  }
}