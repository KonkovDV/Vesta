import type { MasExecutionStore } from '../../domain/mas/MasExecutionStore';
import type { MasTaskExecution } from '../../domain/mas/MasTaskExecution';
import type { MasTaskExecutionInit } from '../../domain/mas/MasTaskExecutionInit';
import type { MasExecutionStep } from '../../domain/mas/MasExecutionStep';
import type { MasStepStatusUpdate } from '../../domain/mas/MasStepStatusUpdate';
import type { MasExecutionError } from '../../domain/mas/MasExecutionError';
import type { MasRecoveryQuery } from '../../domain/mas/MasRecoveryQuery';
import { attachDurableSloDiagnosticsToError } from '../../domain/mas/mas-diagnostics';
import { MasTaskStatus } from '../../domain/mas/MasTaskStatus';
import { MasExecutionStatus } from '../../domain/mas/MasExecutionStatus';
import type { RequestContextSnapshot } from '../../domain/mas/RequestContextSnapshot';
import type { MasResultRef } from '../../domain/mas/MasResultRef';
import { IdGenerator } from '../../core/utils/IdGenerator';
import { mapExecutionErrorToCategory } from '../../domain/mas/services/mas-error-taxonomy';
import { incrementMasErrorsTotal } from '../../monitoring/mas-metrics';

export class InMemoryMasExecutionStore implements MasExecutionStore {
  private readonly tasks = new Map<string, MasTaskExecution>();

  async startTaskExecution(init: MasTaskExecutionInit): Promise<MasTaskExecution> {
    const now = new Date();
    const taskExecutionId = this.generateTaskExecutionId(init.taskId, init.sessionId);
    const task: MasTaskExecution = {
      taskExecutionId,
      taskId: init.taskId,
      sessionId: init.sessionId,
      status: init.status ?? MasTaskStatus.Pending,
      currentStepId: null,
      steps: [],
      attempts: 0,
      lastError: undefined,
      requestContextSnapshot: init.requestContextSnapshot as RequestContextSnapshot,
      timeouts: init.timeouts ?? {},
      meta: init.meta ?? {},
      createdAt: now,
      updatedAt: now,
      lockedBy: undefined,
      lockExpiresAt: undefined,
    };

    this.tasks.set(taskExecutionId, task);
    return task;
  }

  async getTaskExecution(taskExecutionId: string): Promise<MasTaskExecution | null> {
    const task = this.tasks.get(taskExecutionId);
    return task ?? null;
  }

  async findActiveTasksForRecovery(query: MasRecoveryQuery): Promise<MasTaskExecution[]> {
    const taskStatuses =
      query.taskStatuses && query.taskStatuses.length > 0
        ? query.taskStatuses
        : [MasTaskStatus.Running];

    const result: MasTaskExecution[] = [];

    for (const task of this.tasks.values()) {
      if (!taskStatuses.includes(task.status)) {
        continue;
      }
      if (query.updatedBefore && task.updatedAt >= query.updatedBefore) {
        continue;
      }
      if (query.sessionIdEquals && task.sessionId !== query.sessionIdEquals) {
        continue;
      }
      result.push(task);
    }

    result.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

    if (typeof query.maxTasks === 'number' && query.maxTasks > 0) {
      return result.slice(0, query.maxTasks);
    }

    return result;
  }

  async appendStep(
    taskExecutionId: string,
    step: MasExecutionStep,
  ): Promise<MasTaskExecution> {
    const current = this.tasks.get(taskExecutionId);
    if (!current) {
      throw new Error(
        `InMemoryMasExecutionStore.appendStep: taskExecution ${taskExecutionId} not found`,
      );
    }

    const index = current.steps.length;
    const now = new Date();
    const attempts = step.attempts > 0 ? step.attempts : 1;
    const status = step.status ?? MasExecutionStatus.InProgress;

    const normalizedStep: MasExecutionStep = {
      ...step,
      taskExecutionId,
      index,
      attempts,
      status,
      startedAt: step.startedAt ?? now,
      lastHeartbeatAt: step.lastHeartbeatAt ?? now,
    };

    const updated: MasTaskExecution = {
      ...current,
      status:
        current.status === MasTaskStatus.Pending
          ? MasTaskStatus.Running
          : current.status,
      currentStepId: normalizedStep.stepId,
      steps: [...current.steps, normalizedStep],
      updatedAt: now,
    };

    this.tasks.set(taskExecutionId, updated);
    return updated;
  }

  async updateStepStatus(update: MasStepStatusUpdate): Promise<MasTaskExecution> {
    const current = this.tasks.get(update.taskExecutionId);
    if (!current) {
      throw new Error(
        `InMemoryMasExecutionStore.updateStepStatus: taskExecution ${update.taskExecutionId} not found`,
      );
    }

    const now = new Date();

    const steps = current.steps.map(step => {
      if (step.stepId !== update.stepId) {
        return step;
      }

      const status = update.status;
      const attempts =
        typeof update.attempts === 'number' ? update.attempts : step.attempts;

      const completedAt =
        update.completedAt ??
        (this.isTerminalStepStatus(status) ? now : step.completedAt);

      const lastHeartbeatAt = update.lastHeartbeatAt ?? now;

      let error: MasExecutionError | undefined;
      if (update.error === null) {
        error = undefined;
      } else if (update.error) {
        error = attachDurableSloDiagnosticsToError(update.error, current);
      } else if (step.error) {
        error = attachDurableSloDiagnosticsToError(step.error, current);
      } else {
        error = undefined;
      }

      const resultRef: MasResultRef | undefined =
        update.resultRef ?? step.resultRef;

      return {
        ...step,
        status,
        attempts,
        completedAt,
        lastHeartbeatAt,
        error,
        resultRef,
      };
    });

    const updated: MasTaskExecution = {
      ...current,
      steps,
      currentStepId: this.isTerminalStepStatus(update.status)
        ? null
        : current.currentStepId,
      updatedAt: now,
    };

    this.tasks.set(update.taskExecutionId, updated);
    return updated;
  }

  async markTaskCompleted(taskExecutionId: string): Promise<MasTaskExecution> {
    const current = this.tasks.get(taskExecutionId);
    if (!current) {
      throw new Error(
        `InMemoryMasExecutionStore.markTaskCompleted: taskExecution ${taskExecutionId} not found`,
      );
    }
    const now = new Date();
    const updated: MasTaskExecution = {
      ...current,
      status: MasTaskStatus.Completed,
      lastError: undefined,
      currentStepId: null,
      updatedAt: now,
    };
    this.tasks.set(taskExecutionId, updated);
    return updated;
  }

  async markTaskFailed(
    taskExecutionId: string,
    error: MasExecutionError,
  ): Promise<MasTaskExecution> {
    const current = this.tasks.get(taskExecutionId);
    if (!current) {
      throw new Error(
        `InMemoryMasExecutionStore.markTaskFailed: taskExecution ${taskExecutionId} not found`,
      );
    }

    incrementMasErrorsTotal({
      component: 'durable_execution',
      errorType: mapExecutionErrorToCategory(error),
    });

    const now = new Date();
    const enrichedError = attachDurableSloDiagnosticsToError(error, current);

    const updated: MasTaskExecution = {
      ...current,
      status: MasTaskStatus.Failed,
      lastError: enrichedError,
      updatedAt: now,
    };
    this.tasks.set(taskExecutionId, updated);
    return updated;
  }

  async markTaskCancelled(
    taskExecutionId: string,
    reason: string,
  ): Promise<MasTaskExecution> {
    const current = this.tasks.get(taskExecutionId);
    if (!current) {
      throw new Error(
        `InMemoryMasExecutionStore.markTaskCancelled: taskExecution ${taskExecutionId} not found`,
      );
    }
    const now = new Date();
    const baseError: MasExecutionError = {
      code: 'TASK_CANCELLED',
      message: reason,
      details: { taskExecutionId },
      firstOccurredAt: now,
      lastOccurredAt: now,
    };

    const error = attachDurableSloDiagnosticsToError(baseError, current);

    incrementMasErrorsTotal({
      component: 'durable_execution',
      errorType: mapExecutionErrorToCategory(error),
    });
    const updated: MasTaskExecution = {
      ...current,
      status: MasTaskStatus.Cancelled,
      lastError: error,
      updatedAt: now,
    };
    this.tasks.set(taskExecutionId, updated);
    return updated;
  }

  private isTerminalStepStatus(status: MasExecutionStatus): boolean {
    return (
      status === MasExecutionStatus.Completed ||
      status === MasExecutionStatus.Failed ||
      status === MasExecutionStatus.Cancelled ||
      status === MasExecutionStatus.Skipped
    );
  }

  private generateTaskExecutionId(taskId: string, sessionId: string): string {
    const safeTask = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const random = IdGenerator.generateRandomString(8);
    return `inmem_mas_exec_${safeTask}_${safeSession}_${random}`;
  }
}