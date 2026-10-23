/**
 * MasExecutionError - Domain type for MAS execution errors.
 *
 * Layer: Domain (enterprise business rules)
 */

export interface MasExecutionError {
  code: string;
  message: string;
  details: Record<string, unknown>;
  firstOccurredAt: Date;
  lastOccurredAt: Date;
}

export interface DurableSloDiagnostics {
  durableScope: 'tenant_scenario' | 'tenant_global' | 'scenario' | 'global' | 'baseline';
  sloProfileIdInput?: string;
  sloProfileIdResolved?: string;
  effectiveTaskTimeoutMs?: number;
  effectiveStepTimeoutMs?: number;
  effectiveMaxStepRetries?: number;
  effectiveCbBlockedCooldownMs?: number;
  effectiveCbBlockedMaxDurationMs?: number;
  effectiveCbMaxRecoveryAttempts?: number;
}

export interface MasExecutionErrorDetailsBag extends Record<string, unknown> {
  durableSlo?: DurableSloDiagnostics;
  durable_scope?: unknown;
  slo_profile_id_input?: unknown;
  slo_profile_id_resolved?: unknown;
  policy_source?: unknown;
  durable_policy_snapshot?: Record<string, unknown>;
  masErrorCategory?: unknown;
  effective_task_timeout_ms?: number;
  effective_step_timeout_ms?: number;
  effective_max_step_retries?: number;
  effective_cb_blocked_cooldown_ms?: number;
  effective_cb_blocked_max_duration_ms?: number;
  effective_cb_max_recovery_attempts?: number;
}
