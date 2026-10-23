/**
 * MAS Durable Execution - recovery analysis service.
 *
 * Layer: Domain Service (pure domain logic for MAS durable execution).
 *
 * Responsibilities:
 * - analyse running task executions for stuck steps / timeouts;
 * - build a MasRecoveryPlan describing recommended actions;
 * - keep all side-effects (writes, retries) in infrastructure/worker layer.
 */
import type { MasExecutionStore } from '../MasExecutionStore';
import type { MasRecoveryQuery } from '../MasRecoveryQuery';
import type {
  MasRecoveryPlan,
  MasRecoveryTaskAction,
  MasRecoveryStepAction,
  MasRecoveryPlanSummary,
} from '../MasRecoveryPlan';
import { MasTaskStatus } from '../MasTaskStatus';
import { MasExecutionStatus } from '../MasExecutionStatus';
import type { MasTaskExecution } from '../MasTaskExecution';
import type { MasExecutionStep } from '../MasExecutionStep';
import type {
  MasExecutionError,
  MasExecutionErrorDetailsBag,
} from '../MasExecutionError';
import { buildDurableSloDiagnosticsFromTask } from '../mas-diagnostics';
import type { MasErrorCategory } from './mas-error-types';
import { mapExecutionErrorToCategory } from './mas-error-taxonomy';
import type { CircuitBreakerKey } from '../../../core/resilience/CircuitBreakerKey';
import type {
  IMasCircuitBreakerAdvisor,
  MasCircuitBreakerSnapshot,
} from './IMasCircuitBreakerAdvisor';

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_STEP_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export const DEFAULT_MAX_STEP_RETRY_ATTEMPTS = 3;

/**
 * Heuristic window for CIRCUIT_OPEN / Blocked steps:
 * - cooldown: how long we wait before scheduling a retry;
 * - max duration: how long we allow the step to remain Blocked before
 *   moving it to DLQ / dead-letter state.
 *
 * These are intentionally coarse-grained defaults for T009 (STEP 4) and
 * can be tuned or overridden in follow-up tasks together with registry
 * integration.
 */
export const DEFAULT_CB_BLOCKED_COOLDOWN_MS = 60_000; // 1 minute
export const DEFAULT_CB_BLOCKED_MAX_DURATION_MS = 10 * 60_000; // 10 minutes

export interface DurableExecutionPolicy {
  /**
   * Default timeout for the whole durable task execution when no per-task
   * or query-level overrides are provided.
   */
  defaultTaskTimeoutMs: number;

  /**
   * Default timeout for a single durable execution step when no per-task
   * or query-level overrides are provided.
   */
  defaultStepTimeoutMs: number;

  /**
   * Default max retry attempts for a single durable step when step.maxAttempts
   * is not explicitly configured. Used for generic STEP_TIMEOUT handling.
   */
  maxStepRetryAttempts: number;

  /**
   * Cooldown window for CIRCUIT_OPEN / Blocked steps before attempting to
   * recover or retry them.
   */
  cbBlockedCooldownMs: number;

  /**
   * Max duration a step is allowed to remain Blocked due to CIRCUIT_OPEN
   * before being moved to DLQ / dead-letter state.
   */
  cbBlockedMaxDurationMs: number;

  /**
   * Max number of recovery attempts after the circuit breaker has recovered
   * (CLOSED / HALF_OPEN) before moving the step to DLQ.
   */
  cbMaxRecoveryAttempts: number;
}

const R1_R2_BASELINE_DURABLE_POLICY: DurableExecutionPolicy = {
  defaultTaskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  defaultStepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  maxStepRetryAttempts: DEFAULT_MAX_STEP_RETRY_ATTEMPTS,
  cbBlockedCooldownMs: DEFAULT_CB_BLOCKED_COOLDOWN_MS,
  cbBlockedMaxDurationMs: DEFAULT_CB_BLOCKED_MAX_DURATION_MS,
  cbMaxRecoveryAttempts: DEFAULT_MAX_STEP_RETRY_ATTEMPTS,
};

/**
 * Optional provider for durable execution policies. Implementations can
 * source values from MAS runtime policy layer, config, or other inputs.
 *
 * When not provided, MasRecoveryService falls back to R1 defaults defined
 * by the exported DEFAULT_* constants above.
 */
export interface IMasDurableExecutionPolicyProvider {
  getDurableExecutionPolicyForTask(
    task: MasTaskExecution,
  ): DurableExecutionPolicy;
}

type AnalyseTaskResult = {
  taskActions: MasRecoveryTaskAction[];
  stepActions: MasRecoveryStepAction[];
  stepsInspected: number;
  tasksMarkedFailed: number;
  tasksMarkedDeadLettered: number;
  tasksCancelled: number;
  stepsScheduledForRetry: number;
  stepsMarkedFailed: number;
  stepsMarkedDeadLettered: number;
};

export class MasRecoveryService {
  constructor(
    private readonly executionStore: MasExecutionStore,
    private readonly circuitBreakerAdvisor?: IMasCircuitBreakerAdvisor,
    private readonly durablePolicyProvider?: IMasDurableExecutionPolicyProvider,
  ) {}

  async recoverStuckTasks(query: MasRecoveryQuery): Promise<MasRecoveryPlan> {
    const effectiveQuery = this.normalizeQuery(query);
    const candidates = await this.executionStore.findActiveTasksForRecovery(
      effectiveQuery,
    );

    const now = new Date();
    const taskActions: MasRecoveryTaskAction[] = [];
    const stepActions: MasRecoveryStepAction[] = [];

    let tasksInspected = 0;
    let stepsInspected = 0;
    let tasksMarkedFailed = 0;
    let tasksMarkedDeadLettered = 0;
    let tasksCancelled = 0;
    let stepsScheduledForRetry = 0;
    let stepsMarkedFailed = 0;
    let stepsMarkedDeadLettered = 0;

    for (const task of candidates) {
      tasksInspected += 1;
      const taskResult = await this.analyseTask(now, task, effectiveQuery);

      stepsInspected += taskResult.stepsInspected;

      taskActions.push(...taskResult.taskActions);
      stepActions.push(...taskResult.stepActions);

      tasksMarkedFailed += taskResult.tasksMarkedFailed;
      tasksMarkedDeadLettered += taskResult.tasksMarkedDeadLettered;
      tasksCancelled += taskResult.tasksCancelled;
      stepsScheduledForRetry += taskResult.stepsScheduledForRetry;
      stepsMarkedFailed += taskResult.stepsMarkedFailed;
      stepsMarkedDeadLettered += taskResult.stepsMarkedDeadLettered;
    }

    const summary: MasRecoveryPlanSummary = {
      tasksInspected,
      stepsInspected,
      actionsPlanned: taskActions.length + stepActions.length,
      tasksMarkedFailed,
      tasksMarkedDeadLettered,
      tasksCancelled,
      stepsScheduledForRetry,
      stepsMarkedFailed,
      stepsMarkedDeadLettered,
    };

    return {
      query: effectiveQuery,
      taskActions,
      stepActions,
      summary,
      generatedAt: now,
      sourceLabel: effectiveQuery.sourceLabel,
    };
  }

  private normalizeQuery(query: MasRecoveryQuery): MasRecoveryQuery {
    const taskStatuses =
      query.taskStatuses && query.taskStatuses.length > 0
        ? query.taskStatuses
        : [MasTaskStatus.Running];

    const stepStatuses =
      query.stepStatuses && query.stepStatuses.length > 0
        ? query.stepStatuses
        : [MasExecutionStatus.InProgress, MasExecutionStatus.Blocked];

    return {
      ...query,
      taskStatuses,
      stepStatuses,
    };
  }

  private async analyseTask(
    now: Date,
    task: MasTaskExecution,
    query: MasRecoveryQuery,
  ): Promise<AnalyseTaskResult> {
    const result = this.initEmptyResult();

    const durablePolicy =
      this.getEffectiveDurableExecutionPolicyForTask(task);

    const taskTimeoutMs =
      query.taskTimeoutOverrideMs ??
      task.timeouts?.taskTimeoutMs ??
      durablePolicy.defaultTaskTimeoutMs;
    const stepTimeoutMs =
      query.stepTimeoutOverrideMs ??
      task.timeouts?.stepTimeoutMs ??
      durablePolicy.defaultStepTimeoutMs;

    // Task-level timeout check (only for running tasks).
    if (task.status === MasTaskStatus.Running) {
      const elapsedTaskMs = now.getTime() - task.updatedAt.getTime();
      if (elapsedTaskMs > taskTimeoutMs) {
        const error: MasExecutionError = {
          code: 'TASK_TIMEOUT',
          message: 'Durable task execution timed out',
          details: {
            taskExecutionId: task.taskExecutionId,
            taskId: task.taskId,
            elapsedMs: elapsedTaskMs,
            timeoutMs: taskTimeoutMs,
            effective_task_timeout_ms: taskTimeoutMs,
            effective_step_timeout_ms: stepTimeoutMs,
            effective_max_step_retries: durablePolicy.maxStepRetryAttempts,
          },
          firstOccurredAt: now,
          lastOccurredAt: now,
        };

        const enrichedError =
          this.enrichErrorWithCategoryAndDurableDiagnostics(task, error);

        result.taskActions.push({
          taskExecutionId: task.taskExecutionId,
          action: 'mark_failed',
          error: enrichedError,
          reasonCode: 'TASK_TIMEOUT',
          currentStatus: task.status,
        });
        result.tasksMarkedFailed += 1;
      }
    }

    const candidateStepStatuses = new Set(query.stepStatuses);

    for (const step of task.steps) {
      if (!candidateStepStatuses.has(step.status)) {
        continue;
      }

      result.stepsInspected += 1;

      const isCircuitOpenBlocked =
        step.status === MasExecutionStatus.Blocked &&
        step.error?.code === 'CIRCUIT_OPEN';

      if (isCircuitOpenBlocked) {
        const cbAnalysis = await this.analyseCircuitOpenBlockedStep(
          now,
          task,
          step,
          durablePolicy,
        );
        this.mergeResults(result, cbAnalysis);
        continue;
      }

      const stepLastActive =
        step.lastHeartbeatAt ??
        step.startedAt ??
        task.updatedAt;
      const elapsedStepMs = now.getTime() - stepLastActive.getTime();

      if (elapsedStepMs <= stepTimeoutMs) {
        continue;
      }

      const maxAttempts =
        typeof step.maxAttempts === 'number' && step.maxAttempts > 0
          ? step.maxAttempts
          : durablePolicy.maxStepRetryAttempts;

      const isRetryPossible = step.attempts < maxAttempts;

      const baseError: MasExecutionError = {
        code: 'STEP_TIMEOUT',
        message: 'Durable execution step considered stuck by timeout',
        details: {
          taskExecutionId: task.taskExecutionId,
          taskId: task.taskId,
          stepId: step.stepId,
          stepIndex: step.index,
          stepKind: step.kind,
          elapsedMs: elapsedStepMs,
          timeoutMs: stepTimeoutMs,
          attempts: step.attempts,
          maxAttempts,
          effective_task_timeout_ms: taskTimeoutMs,
          effective_step_timeout_ms: stepTimeoutMs,
          effective_max_step_retries: maxAttempts,
        },
        firstOccurredAt: now,
        lastOccurredAt: now,
      };

      const enrichedTimeoutError =
        this.enrichErrorWithCategoryAndDurableDiagnostics(task, baseError);

      if (isRetryPossible) {
        result.stepActions.push({
          taskExecutionId: task.taskExecutionId,
          stepId: step.stepId,
          action: 'retry',
          error: enrichedTimeoutError,
          reasonCode: 'STEP_TIMEOUT',
          currentStatus: step.status,
        });
        result.stepsScheduledForRetry += 1;
      } else {
        const maxRetriesExceededError: MasExecutionError =
          this.enrichErrorWithCategoryAndDurableDiagnostics(task, {
            ...baseError,
            code: 'MAX_STEP_RETRIES_EXCEEDED',
          });

        result.stepActions.push({
          taskExecutionId: task.taskExecutionId,
          stepId: step.stepId,
          action: 'mark_failed',
          error: maxRetriesExceededError,
          reasonCode: 'MAX_STEP_RETRIES_EXCEEDED',
          currentStatus: step.status,
        });
        result.stepsMarkedFailed += 1;
      }
    }

    return result;
  }

  private initEmptyResult(): AnalyseTaskResult {
    return {
      taskActions: [],
      stepActions: [],
      stepsInspected: 0,
      tasksMarkedFailed: 0,
      tasksMarkedDeadLettered: 0,
      tasksCancelled: 0,
      stepsScheduledForRetry: 0,
      stepsMarkedFailed: 0,
      stepsMarkedDeadLettered: 0,
    };
  }

  private getEffectiveDurableExecutionPolicyForTask(
    task: MasTaskExecution,
  ): DurableExecutionPolicy {
    if (this.durablePolicyProvider) {
      const policy =
        this.durablePolicyProvider.getDurableExecutionPolicyForTask(task);
      if (policy) {
        return policy;
      }
    }

    return R1_R2_BASELINE_DURABLE_POLICY;
  }

  private mergeResults(target: AnalyseTaskResult, delta: AnalyseTaskResult): void {
    target.taskActions.push(...delta.taskActions);
    target.stepActions.push(...delta.stepActions);
    target.stepsInspected += delta.stepsInspected;
    target.tasksMarkedFailed += delta.tasksMarkedFailed;
    target.tasksMarkedDeadLettered += delta.tasksMarkedDeadLettered;
    target.tasksCancelled += delta.tasksCancelled;
    target.stepsScheduledForRetry += delta.stepsScheduledForRetry;
    target.stepsMarkedFailed += delta.stepsMarkedFailed;
    target.stepsMarkedDeadLettered += delta.stepsMarkedDeadLettered;
  }

  private tryExtractCircuitBreakerKeyFromStep(
    step: MasExecutionStep,
  ): CircuitBreakerKey | null {
    const details = step.error?.details as
      | { cb?: { key?: CircuitBreakerKey } }
      | undefined;
    const cb = details?.cb;
    return cb?.key ?? null;
  }

  private async analyseCircuitOpenBlockedStep(
    now: Date,
    task: MasTaskExecution,
    step: MasExecutionStep,
    policy: DurableExecutionPolicy,
  ): Promise<AnalyseTaskResult> {
    const result = this.initEmptyResult();

    const {
      cbBlockedCooldownMs,
      cbBlockedMaxDurationMs,
      cbMaxRecoveryAttempts,
    } = policy;

    const lastErrorAt =
      step.error?.lastOccurredAt ??
      step.lastHeartbeatAt ??
      step.startedAt ??
      task.updatedAt;
    const elapsedMs = now.getTime() - lastErrorAt.getTime();

    if (elapsedMs < cbBlockedCooldownMs) {
      // Fresh CIRCUIT_OPEN – give the breaker time to cool down before retry.
      return result;
    }

    const cbKey = this.tryExtractCircuitBreakerKeyFromStep(step);
    let snapshot: MasCircuitBreakerSnapshot | null = null;

    if (cbKey && this.circuitBreakerAdvisor) {
      try {
        snapshot = await this.circuitBreakerAdvisor.getSnapshotForKey(
          cbKey,
          now,
        );
      } catch {
        snapshot = null;
      }
    }

    if (!snapshot) {
      return this.analyseCircuitOpenBlockedWithoutCbState(
        now,
        task,
        step,
        elapsedMs,
        policy,
      );
    }

    if (snapshot.state === 'OPEN') {
      if (elapsedMs < cbBlockedMaxDurationMs) {
        // Breaker still OPEN but within max duration window – keep waiting.
        return result;
      }

      const isStuckOpen =
        snapshot.metrics.errorRate >= 50 ||
        snapshot.metrics.rejectedCalls >= 10 ||
        snapshot.stateDurationMs >= cbBlockedMaxDurationMs;

      if (!isStuckOpen) {
        return result;
      }

      const error = this.buildDeadLetterErrorForCbStuckOpen(
        now,
        task,
        step,
        snapshot,
        policy,
      );

      result.stepActions.push({
        taskExecutionId: task.taskExecutionId,
        stepId: step.stepId,
        action: 'mark_dead_lettered',
        error,
        reasonCode: 'CB_STUCK_OPEN',
        currentStatus: step.status,
      });
      result.stepsMarkedDeadLettered += 1;

      return result;
    }

    // CLOSED / HALF_OPEN – breaker recovered, consider retries.
    const maxAttempts =
      typeof step.maxAttempts === 'number' && step.maxAttempts > 0
        ? step.maxAttempts
        : cbMaxRecoveryAttempts;
    const isRetryPossible = step.attempts < maxAttempts;

    if (isRetryPossible) {
      const baseDetails = (step.error?.details ?? {});
      const error: MasExecutionError = {
        code: 'CIRCUIT_OPEN',
        message: 'Circuit breaker recovered, scheduling MAS step retry',
        details: {
          ...baseDetails,
          cbStateAtRecovery: {
            state: snapshot.state,
            errorRate: snapshot.metrics.errorRate,
          },
          taskExecutionId: task.taskExecutionId,
          taskId: task.taskId,
          stepId: step.stepId,
          stepIndex: step.index,
          cb_blocked_cooldown_ms: cbBlockedCooldownMs,
          cb_blocked_max_duration_ms: cbBlockedMaxDurationMs,
          cb_max_recovery_attempts: cbMaxRecoveryAttempts,
          effective_max_step_retries: maxAttempts,
        },
        firstOccurredAt: now,
        lastOccurredAt: now,
      };

      const enrichedError = this.enrichErrorWithCategoryAndDurableDiagnostics(
        task,
        error,
      );

      result.stepActions.push({
        taskExecutionId: task.taskExecutionId,
        stepId: step.stepId,
        action: 'retry',
        error: enrichedError,
        reasonCode: 'CB_RECOVERED',
        currentStatus: step.status,
      });
      result.stepsScheduledForRetry += 1;

      return result;
    }

    // Breaker recovered but step exhausted its retry attempts – move to DLQ.
    const baseDetails = (step.error?.details ?? {});
    const dlqError: MasExecutionError = {
      code: 'CB_RECOVERED_MAX_ATTEMPTS_EXCEEDED',
      message:
        'MAS step blocked by CIRCUIT_OPEN has recovered but max retry attempts are exhausted; moving to DLQ',
      details: {
        ...baseDetails,
        cbStateAtRecovery: {
          state: snapshot.state,
          errorRate: snapshot.metrics.errorRate,
        },
        taskExecutionId: task.taskExecutionId,
        taskId: task.taskId,
        stepId: step.stepId,
        stepIndex: step.index,
        attempts: step.attempts,
        maxAttempts,
        cb_blocked_cooldown_ms: cbBlockedCooldownMs,
        cb_blocked_max_duration_ms: cbBlockedMaxDurationMs,
        cb_max_recovery_attempts: cbMaxRecoveryAttempts,
        effective_max_step_retries: maxAttempts,
      },
      firstOccurredAt: now,
      lastOccurredAt: now,
    };

    const enrichedDlqError = this.enrichErrorWithCategoryAndDurableDiagnostics(
      task,
      dlqError,
    );

    result.stepActions.push({
      taskExecutionId: task.taskExecutionId,
      stepId: step.stepId,
      action: 'mark_dead_lettered',
      error: enrichedDlqError,
      reasonCode: 'CB_RECOVERED_MAX_ATTEMPTS_EXCEEDED',
      currentStatus: step.status,
    });
    result.stepsMarkedDeadLettered += 1;

    return result;
  }

  private analyseCircuitOpenBlockedWithoutCbState(
    now: Date,
    task: MasTaskExecution,
    step: MasExecutionStep,
    elapsedMs: number,
    policy: DurableExecutionPolicy,
  ): AnalyseTaskResult {
    const result = this.initEmptyResult();

    const { cbBlockedCooldownMs, cbBlockedMaxDurationMs } = policy;

    if (elapsedMs < cbBlockedCooldownMs) {
      return result;
    }

    if (elapsedMs >= cbBlockedMaxDurationMs) {
      const error: MasExecutionError = {
        code: 'STEP_DEAD_LETTERED',
        message:
          'MAS step blocked by CIRCUIT_OPEN for too long; moving to DLQ',
        details: {
          taskExecutionId: task.taskExecutionId,
          taskId: task.taskId,
          stepId: step.stepId,
          stepIndex: step.index,
          previousErrorCode: step.error?.code,
          cb_blocked_cooldown_ms: cbBlockedCooldownMs,
          cb_blocked_max_duration_ms: cbBlockedMaxDurationMs,
          elapsedMs,
        },
        firstOccurredAt: now,
        lastOccurredAt: now,
      };

      const enrichedError = this.enrichErrorWithCategoryAndDurableDiagnostics(
        task,
        error,
      );

      result.stepActions.push({
        taskExecutionId: task.taskExecutionId,
        stepId: step.stepId,
        action: 'mark_dead_lettered',
        error: enrichedError,
        reasonCode: 'CB_BLOCKED_TOO_LONG',
        currentStatus: step.status,
      });
      result.stepsMarkedDeadLettered += 1;

      return result;
    }

    const baseError = step.error;
    const error: MasExecutionError = {
      code: 'CIRCUIT_OPEN',
      message:
        baseError?.message ??
        'MAS step blocked by CIRCUIT_OPEN, scheduling retry',
      details: {
        ...(baseError?.details ?? {}),
        taskExecutionId: task.taskExecutionId,
        taskId: task.taskId,
        stepId: step.stepId,
        stepIndex: step.index,
        cb_blocked_cooldown_ms: cbBlockedCooldownMs,
        cb_blocked_max_duration_ms: cbBlockedMaxDurationMs,
        elapsedMs,
      },
      firstOccurredAt: baseError?.firstOccurredAt ?? now,
      lastOccurredAt: now,
    };

    const enrichedError = this.enrichErrorWithCategoryAndDurableDiagnostics(
      task,
      error,
    );

    result.stepActions.push({
      taskExecutionId: task.taskExecutionId,
      stepId: step.stepId,
      action: 'retry',
      error: enrichedError,
      reasonCode: 'CIRCUIT_OPEN',
      currentStatus: step.status,
    });
    result.stepsScheduledForRetry += 1;

    return result;
  }

  private buildDeadLetterErrorForCbStuckOpen(
    now: Date,
    task: MasTaskExecution,
    step: MasExecutionStep,
    snapshot: MasCircuitBreakerSnapshot,
    policy: DurableExecutionPolicy,
  ): MasExecutionError {
    const baseDetails = (step.error?.details ?? {});

    const {
      cbBlockedCooldownMs,
      cbBlockedMaxDurationMs,
      cbMaxRecoveryAttempts,
    } = policy;

    const error: MasExecutionError = {
      code: 'CB_STUCK_OPEN',
      message:
        'MAS step blocked by a circuit breaker that appears to be stuck OPEN; moving to DLQ',
      details: {
        ...baseDetails,
        taskExecutionId: task.taskExecutionId,
        taskId: task.taskId,
        stepId: step.stepId,
        stepIndex: step.index,
        cbStateAtDecision: {
          state: snapshot.state,
          errorRate: snapshot.metrics.errorRate,
          rejectedCalls: snapshot.metrics.rejectedCalls,
          failures: snapshot.metrics.failures,
          timeouts: snapshot.metrics.timeouts,
          stateDurationMs: snapshot.stateDurationMs,
        },
        cb_blocked_cooldown_ms: cbBlockedCooldownMs,
        cb_blocked_max_duration_ms: cbBlockedMaxDurationMs,
        cb_max_recovery_attempts: cbMaxRecoveryAttempts,
      },
      firstOccurredAt: now,
      lastOccurredAt: now,
    };

    return this.enrichErrorWithCategoryAndDurableDiagnostics(task, error);
  }

  private enrichErrorWithCategoryAndDurableDiagnostics(
    task: MasTaskExecution,
    error: MasExecutionError,
  ): MasExecutionError {
    const withDiagnostics = this.attachDurablePolicyDiagnosticsToError(
      task,
      error,
    );
    return this.enrichErrorWithCategory(withDiagnostics);
  }

  private enrichErrorWithCategory(error: MasExecutionError): MasExecutionError {
    const category: MasErrorCategory = mapExecutionErrorToCategory(error);

    const details: Record<string, unknown> = {
      ...(error.details ?? {}),
      masErrorCategory: category,
    };

    return {
      ...error,
      details,
    };
  }

  private attachDurablePolicyDiagnosticsToError(
    task: MasTaskExecution,
    error: MasExecutionError,
  ): MasExecutionError {
    try {
      const baseDetails = (error.details ?? {}) as MasExecutionErrorDetailsBag;
      const enrichedDetails = this.buildDurablePolicyDiagnosticsDetails(
        task,
        baseDetails,
      );

      if (!enrichedDetails.durableSlo) {
        const diagnostics = buildDurableSloDiagnosticsFromTask(task);
        if (diagnostics) {
          enrichedDetails.durableSlo = diagnostics;
        }
      }

      return {
        ...error,
        details: enrichedDetails,
      };
    } catch {
      return error;
    }
  }

  private buildDurablePolicyDiagnosticsDetails(
    task: MasTaskExecution,
    baseDetails: MasExecutionErrorDetailsBag,
  ): MasExecutionErrorDetailsBag {
    try {
      const meta = (task.meta ?? {});
      const debug =
        meta.durable_policy_debug as
          | {
              durable_scope?: unknown;
              slo_profile_id_input?: unknown;
              slo_profile_id_resolved?: unknown;
              policy_source?: unknown;
              durable_policy_snapshot?: Record<string, unknown>;
            }
          | undefined;

      if (!debug || typeof debug !== 'object') {
        return baseDetails;
      }

      const details: MasExecutionErrorDetailsBag = { ...baseDetails };

      const detailsRecord = details as Record<string, unknown>;

      if (
        debug.durable_scope !== undefined &&
        detailsRecord.durable_scope === undefined
      ) {
        detailsRecord.durable_scope = debug.durable_scope;
      }

      if (
        debug.slo_profile_id_input !== undefined &&
        detailsRecord.slo_profile_id_input === undefined
      ) {
        detailsRecord.slo_profile_id_input = debug.slo_profile_id_input;
      }

      if (
        debug.slo_profile_id_resolved !== undefined &&
        detailsRecord.slo_profile_id_resolved === undefined
      ) {
        detailsRecord.slo_profile_id_resolved = debug.slo_profile_id_resolved;
      }

      if (
        debug.policy_source !== undefined &&
        detailsRecord.policy_source === undefined
      ) {
        detailsRecord.policy_source = debug.policy_source;
      }

      const snapshot = debug.durable_policy_snapshot;
      if (snapshot && typeof snapshot === 'object') {
        const effectiveTaskTimeout =
          snapshot.effective_task_timeout_ms;
        const effectiveStepTimeout =
          snapshot.effective_step_timeout_ms;
        const effectiveMaxStepRetries =
          snapshot.effective_max_step_retries;
        const effectiveCbCooldown =
          snapshot.effective_cb_blocked_cooldown_ms;
        const effectiveCbMaxDuration =
          snapshot.effective_cb_blocked_max_duration_ms;
        const effectiveCbMaxRecovery =
          snapshot.effective_cb_max_recovery_attempts;

        if (
          detailsRecord.effective_task_timeout_ms === undefined &&
          typeof effectiveTaskTimeout === 'number'
        ) {
          detailsRecord.effective_task_timeout_ms = effectiveTaskTimeout;
        }

        if (
          detailsRecord.effective_step_timeout_ms === undefined &&
          typeof effectiveStepTimeout === 'number'
        ) {
          detailsRecord.effective_step_timeout_ms = effectiveStepTimeout;
        }

        if (
          detailsRecord.effective_max_step_retries === undefined &&
          typeof effectiveMaxStepRetries === 'number'
        ) {
          detailsRecord.effective_max_step_retries = effectiveMaxStepRetries;
        }

        if (
          detailsRecord.effective_cb_blocked_cooldown_ms === undefined &&
          typeof effectiveCbCooldown === 'number'
        ) {
          detailsRecord.effective_cb_blocked_cooldown_ms = effectiveCbCooldown;
        }

        if (
          detailsRecord.effective_cb_blocked_max_duration_ms === undefined &&
          typeof effectiveCbMaxDuration === 'number'
        ) {
          detailsRecord.effective_cb_blocked_max_duration_ms =
            effectiveCbMaxDuration;
        }

        if (
          detailsRecord.effective_cb_max_recovery_attempts === undefined &&
          typeof effectiveCbMaxRecovery === 'number'
        ) {
          detailsRecord.effective_cb_max_recovery_attempts =
            effectiveCbMaxRecovery;
        }
      }

      return details;
    } catch {
      return baseDetails;
    }
  }
}
