/**
 * MAS Durable Execution - recovery worker.
 *
 * Layer: Infrastructure (background worker).
 *
 * Responsibilities:
 * - periodically invoke MasRecoveryService.recoverStuckTasks();
 * - apply recovery actions to MasExecutionStore (mark tasks failed/cancelled, steps failed);
 * - expose start/stop/close/isHealthy for DI/bootstrap.
 *
 * NOTE:
 * - This worker focuses on durable state transitions; actual business-level
 *   re-execution of MAS tasks/steps will be wired via MasterAgent/MAS runtime
 *   in follow-up iterations.
 */

import type { MasRecoveryService } from '../../domain/mas/services/MasRecoveryService';
import type { MasExecutionStore } from '../../domain/mas/MasExecutionStore';
import type { MasRecoveryQuery } from '../../domain/mas/MasRecoveryQuery';
import type {
  MasRecoveryPlan,
  MasRecoveryTaskAction,
  MasRecoveryStepAction,
} from '../../domain/mas/MasRecoveryPlan';
import type { MasExecutionError } from '../../domain/mas/MasExecutionError';
import { MasExecutionStatus } from '../../domain/mas/MasExecutionStatus';
import type { ILogger } from '../../core/decorators/ILogger';
import { mapExecutionErrorToCategory } from '../../domain/mas/services/mas-error-taxonomy';
import { incrementMasErrorsTotal } from '../../monitoring/mas-metrics';

export interface MasRecoveryWorkerOptions {
  /** Interval between recovery scans (ms). Default: 60s. */
  intervalMs?: number;
  /** Base query used for all recovery passes (can be overridden per runOnce). */
  baseQuery?: MasRecoveryQuery;
}

/**
 * Default MAS durable recovery settings.
 */
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BASE_QUERY: MasRecoveryQuery = {
  maxTasks: 100,
  maxStepsPerTask: 100,
};

export class MasRecoveryWorker {
  private readonly intervalMs: number;
  private readonly baseQuery: MasRecoveryQuery;
  private timer?: NodeJS.Timeout;
  private running = false;
  private executing = false;
  private lastRunAt?: Date;
  private lastError?: Error;

  constructor(
    private readonly recoveryService: MasRecoveryService,
    private readonly executionStore: MasExecutionStore,
    private readonly logger?: ILogger,
    options?: MasRecoveryWorkerOptions,
  ) {
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.baseQuery = {
      ...DEFAULT_BASE_QUERY,
      ...(options?.baseQuery ?? {}),
    };
  }

  /**
   * Start periodic recovery loop.
   * Idempotent: repeated calls while running are ignored.
   */
  start(): void {
    if (this.timer) {
      return;
    }

    this.running = true;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.logError('mas_recovery_worker_run_failed', {
          message: this.lastError.message,
        });
      });
    }, this.intervalMs);

    this.logInfo('mas_recovery_worker_started', {
      intervalMs: this.intervalMs,
    });
  }

  /**
   * Stop periodic recovery loop.
   * Idempotent.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.logInfo('mas_recovery_worker_stopped');
  }

  /**
   * Graceful shutdown hook for DI bootstrap.
   */
  async close(): Promise<void> {
    this.stop();
  }

  /**
   * Lightweight health indicator for bootstrap diagnostics.
   */
  async isHealthy(): Promise<boolean> {
    // Worker itself has no external dependencies beyond recoveryService/executionStore,
    // which are verified by their own health checks. Here we only report whether
    // the loop is operational and did not hit unrecoverable errors.
    if (this.lastError) {
      return false;
    }
    return true;
  }

  /**
   * Execute a single recovery pass.
   *
   * When called while the periodic loop is running, it reuses baseQuery and
   * applies the plan immediately. When called with overrideQuery, it performs
   * a one-off recovery pass independent from the loop.
   */
  async runOnce(overrideQuery?: MasRecoveryQuery): Promise<MasRecoveryPlan | null> {
    const query: MasRecoveryQuery = {
      ...this.baseQuery,
      ...(overrideQuery ?? {}),
    };

    if (!this.running && !overrideQuery) {
      // Worker is stopped and no explicit query provided: skip.
      this.logInfo('mas_recovery_worker_run_skipped', {
        reason: 'worker_not_running',
      });
      return null;
    }

    // Re-entry guard: prevent overlapping recovery passes when previous
    // pass takes longer than intervalMs.
    if (this.executing) {
      this.logWarn('mas_recovery_worker_run_skipped', {
        reason: 'previous_pass_still_running',
      });
      return null;
    }

    this.executing = true;
    try {
      return await this.executePass(query);
    } finally {
      this.executing = false;
    }
  }

  private async executePass(query: MasRecoveryQuery): Promise<MasRecoveryPlan | null> {
    this.logInfo('mas_recovery_worker_run_started', {
      maxTasks: query.maxTasks,
      maxStepsPerTask: query.maxStepsPerTask,
      sourceLabel: query.sourceLabel,
    });

    const plan = await this.recoveryService.recoverStuckTasks(query);
    this.lastRunAt = new Date();
    // Reset lastError on successful pass so isHealthy() recovers.
    this.lastError = undefined;

    if (plan.summary.actionsPlanned === 0) {
      this.logInfo('mas_recovery_worker_run_completed', {
        tasksInspected: plan.summary.tasksInspected,
        stepsInspected: plan.summary.stepsInspected,
        actionsPlanned: 0,
      });
      return plan;
    }

    await this.applyPlan(plan);

    // Reset lastError after successful plan application.
    this.lastError = undefined;

    this.logInfo('mas_recovery_worker_run_completed', {
      tasksInspected: plan.summary.tasksInspected,
      stepsInspected: plan.summary.stepsInspected,
      actionsPlanned: plan.summary.actionsPlanned,
      tasksMarkedFailed: plan.summary.tasksMarkedFailed,
      tasksMarkedDeadLettered: plan.summary.tasksMarkedDeadLettered,
      tasksCancelled: plan.summary.tasksCancelled,
      stepsScheduledForRetry: plan.summary.stepsScheduledForRetry,
      stepsMarkedFailed: plan.summary.stepsMarkedFailed,
      stepsMarkedDeadLettered: plan.summary.stepsMarkedDeadLettered,
    });

    return plan;
  }

  private async applyPlan(plan: MasRecoveryPlan): Promise<void> {
    for (const action of plan.taskActions) {
      await this.applyTaskAction(action);
    }

    for (const action of plan.stepActions) {
      await this.applyStepAction(action);
    }
  }

  private async applyTaskAction(action: MasRecoveryTaskAction): Promise<void> {
    try {
      if (action.action === 'mark_failed') {
        const error =
          action.error ??
          this.buildSyntheticError(
            'TASK_FAILED',
            action.reasonCode ?? 'TASK_FAILED',
            { taskExecutionId: action.taskExecutionId },
          );

        this.recordDurableRecoveryError(error);

        await this.executionStore.markTaskFailed(action.taskExecutionId, error);
      } else if (action.action === 'cancel') {
        const reason = action.reasonCode ?? 'TASK_CANCELLED_BY_RECOVERY';
        await this.executionStore.markTaskCancelled(
          action.taskExecutionId,
          reason,
        );
      } else if (action.action === 'mark_dead_lettered') {
        const baseError =
          action.error ??
          this.buildSyntheticError(
            'DEAD_LETTERED',
            action.reasonCode ?? 'TASK_DEAD_LETTERED',
            { taskExecutionId: action.taskExecutionId },
          );
        const error: MasExecutionError = {
          ...baseError,
          code: 'DEAD_LETTERED',
        };
        await this.executionStore.markTaskFailed(action.taskExecutionId, error);
      }
    } catch (error) {
      this.handleError('task', action.taskExecutionId, error);
    }
  }

  private async applyStepAction(action: MasRecoveryStepAction): Promise<void> {
    try {
      if (action.action === 'mark_failed' || action.action === 'mark_dead_lettered') {
        const code =
          action.action === 'mark_dead_lettered'
            ? 'STEP_DEAD_LETTERED'
            : 'STEP_FAILED';

        const baseError =
          action.error ??
          this.buildSyntheticError(
            code,
            action.reasonCode ?? code,
            {
              taskExecutionId: action.taskExecutionId,
              stepId: action.stepId,
            },
          );

        const error: MasExecutionError = {
          ...baseError,
          code,
        };

        this.recordDurableRecoveryError(error);

        const now = new Date();
        await this.executionStore.updateStepStatus({
          taskExecutionId: action.taskExecutionId,
          stepId: action.stepId,
          status: MasExecutionStatus.Failed,
          error,
          completedAt: now,
          lastHeartbeatAt: now,
        });
      } else if (action.action === 'retry') {
        // Retry semantics for MAS Durable Execution will be implemented together
        // with MasterAgent/MAS runtime integration. For now we only record the
        // planned retry in logs to make plans observable, but we still treat the
        // underlying MasExecutionError as part of durable_recovery error budget.
        //
        // NOTE:
        // - Some of these retries may correspond to CIRCUIT_OPEN / Blocked
        //   steps detected by MasRecoveryService. Actual re-execution of MAS
        //   steps will be implemented in follow-up workers once the runtime
        //   is capable of resuming durable steps.
        this.recordDurableRecoveryError(action.error);
        this.logWarn('mas_recovery_step_retry_planned', {
          taskExecutionId: action.taskExecutionId,
          stepId: action.stepId,
          reasonCode: action.reasonCode,
        });
      }
    } catch (error) {
      this.handleError(
        'step',
        action.taskExecutionId,
        error,
        action.stepId,
      );
    }
  }

  private buildSyntheticError(
    code: string,
    reasonCode: string,
    details?: Record<string, unknown>,
  ): MasExecutionError {
    const now = new Date();
    return {
      code,
      message: `Durable Execution recovery action: ${reasonCode}`,
      details: details ?? {},
      firstOccurredAt: now,
      lastOccurredAt: now,
    };
  }

  private handleError(
    scope: 'task' | 'step',
    taskExecutionId: string,
    error: unknown,
    stepId?: string,
  ): void {
    const asError = error instanceof Error ? error : new Error(String(error));
    this.lastError = asError;

    this.logError('mas_recovery_worker_apply_error', {
      scope,
      taskExecutionId,
      stepId,
      errorName: asError.name,
      errorMessage: asError.message,
    });
  }

  private recordDurableRecoveryError(error: MasExecutionError | undefined): void {
    if (!error) {
      return;
    }

    try {
      const rawDetails = (error.details ?? {}) as { masErrorCategory?: unknown };
      const category =
        typeof rawDetails.masErrorCategory === 'string'
          ? rawDetails.masErrorCategory
          : mapExecutionErrorToCategory(error);

      incrementMasErrorsTotal({
        component: 'durable_recovery',
        errorType: category,
      });
    } catch {
      // Metrics must be best-effort and must not break recovery worker.
    }
  }

  // @audit-ok: guarded fallback — logger is checked first, console is last resort
  private logInfo(message: string, meta?: Record<string, unknown>): void {
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(message, meta);
      return;
    }
     
    console.log(`[MasRecoveryWorker] ${message}`, meta);
  }

  private logWarn(message: string, meta?: Record<string, unknown>): void {
    if (this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn(message, meta);
      return;
    }
     
    console.warn(`[MasRecoveryWorker] ${message}`, meta);
  }

  private logError(message: string, meta?: Record<string, unknown>): void {
    if (this.logger && typeof this.logger.error === 'function') {
      this.logger.error(message, meta);
      return;
    }
     
    console.error(`[MasRecoveryWorker] ${message}`, meta);
  }
}