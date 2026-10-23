import type { MasTaskExecution } from './MasTaskExecution';
import type {
  DurableSloDiagnostics,
  MasExecutionError,
  MasExecutionErrorDetailsBag,
} from './MasExecutionError';

/**
 * Helpers for MAS durable execution diagnostics.
 *
 * These utilities provide a safe mapping from MasTaskExecution.meta
 * durable_policy_debug snapshot into structured DurableSloDiagnostics
 * and allow attaching it to MasExecutionError instances.
 */
export function buildDurableSloDiagnosticsFromTask(
  task: MasTaskExecution,
): DurableSloDiagnostics | undefined {
  try {
    if (!task || typeof task !== 'object') {
      return undefined;
    }

    const meta = (task.meta ?? {});
    const debug = meta.durable_policy_debug as
      | {
          durable_scope?: unknown;
          slo_profile_id_input?: unknown;
          slo_profile_id_resolved?: unknown;
          durable_policy_snapshot?: Record<string, unknown>;
        }
      | undefined;

    if (!debug || typeof debug !== 'object') {
      return undefined;
    }

    const scope = debug.durable_scope;
    if (
      scope !== 'tenant_scenario' &&
      scope !== 'tenant_global' &&
      scope !== 'scenario' &&
      scope !== 'global' &&
      scope !== 'baseline'
    ) {
      return undefined;
    }

    const result: DurableSloDiagnostics = {
      durableScope: scope,
    };

    const sloInput = debug.slo_profile_id_input;
    if (typeof sloInput === 'string' && sloInput.length > 0) {
      result.sloProfileIdInput = sloInput;
    }

    const sloResolved = debug.slo_profile_id_resolved;
    if (typeof sloResolved === 'string' && sloResolved.length > 0) {
      result.sloProfileIdResolved = sloResolved;
    }

    const snapshot = debug.durable_policy_snapshot;
    if (snapshot && typeof snapshot === 'object') {
      const effectiveTaskTimeout = snapshot.effective_task_timeout_ms;
      if (typeof effectiveTaskTimeout === 'number') {
        result.effectiveTaskTimeoutMs = effectiveTaskTimeout;
      }

      const effectiveStepTimeout = snapshot.effective_step_timeout_ms;
      if (typeof effectiveStepTimeout === 'number') {
        result.effectiveStepTimeoutMs = effectiveStepTimeout;
      }

      const effectiveMaxStepRetries =
        snapshot.effective_max_step_retries;
      if (typeof effectiveMaxStepRetries === 'number') {
        result.effectiveMaxStepRetries = effectiveMaxStepRetries;
      }

      const effectiveCbCooldown =
        snapshot.effective_cb_blocked_cooldown_ms;
      if (typeof effectiveCbCooldown === 'number') {
        result.effectiveCbBlockedCooldownMs = effectiveCbCooldown;
      }

      const effectiveCbMaxDuration =
        snapshot.effective_cb_blocked_max_duration_ms;
      if (typeof effectiveCbMaxDuration === 'number') {
        result.effectiveCbBlockedMaxDurationMs = effectiveCbMaxDuration;
      }

      const effectiveCbMaxRecovery =
        snapshot.effective_cb_max_recovery_attempts;
      if (typeof effectiveCbMaxRecovery === 'number') {
        result.effectiveCbMaxRecoveryAttempts = effectiveCbMaxRecovery;
      }
    }

    return result;
  } catch {
    return undefined;
  }
}

export function attachDurableSloDiagnosticsToError(
  error: MasExecutionError,
  task: MasTaskExecution,
): MasExecutionError {
  try {
    const diagnostics = buildDurableSloDiagnosticsFromTask(task);
    if (!diagnostics) {
      return error;
    }

    const baseDetails = (error.details ?? {}) as MasExecutionErrorDetailsBag;

    if (baseDetails.durableSlo) {
      return {
        ...error,
        details: baseDetails,
      };
    }

    return {
      ...error,
      details: {
        ...baseDetails,
        durableSlo: diagnostics,
      },
    };
  } catch {
    return error;
  }
}