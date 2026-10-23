import type {
  IExecutionStrategy,
  ExecutionResult,
  ExecutionResultMetadata,
  ExecutionStrategyContext,
  TaskExecutor,
  ExecutionStepResult,
} from '../core/execution-strategy';
import type {
  MasTaskPlan,
  MasTask,
  MasTaskId,
} from '../types/mas-types';

/**
 * MAS-A3.1: Sequential execution strategy.
 *
 * Responsibilities:
 * - iterate over tasks in plan.tasks order while respecting dependsOn;
 * - execute only tasks whose dependencies completed successfully;
 * - mark tasks as skipped when any dependency failed or cannot be resolved;
 * - produce an ExecutionResult with updated MasTaskPlan and per-step details.
 */
export class SequentialExecutionStrategy implements IExecutionStrategy {
  public readonly type = 'sequential' as const;

  public async executePlan(
    plan: MasTaskPlan,
    context: ExecutionStrategyContext,
    executor: TaskExecutor,
  ): Promise<ExecutionResult> {
    const tasks = plan.tasks ?? [];
    const steps: ExecutionStepResult[] = [];
    const executed = new Map<MasTaskId, ExecutionStepResult>();
    const remaining = new Set<MasTaskId>();

    // Resumption logic: pre-fill state from existing plan
    for (const task of tasks) {
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'skipped') {
            // Reconstruct a "virtual" execution step for dependency resolution
            executed.set(task.id, {
                task,
                success: task.status === 'completed',
                skipped: task.status === 'skipped',
                result: null, // We don't have the result here, but we have status for deps
                failureReason: task.status === 'failed' ? 'unknown' : undefined // 'restored_from_history' is not a valid enum value, using 'unknown'
            });
        } else {
            remaining.add(task.id);
        }
    }

    let madeProgress = true;

    while (remaining.size > 0 && madeProgress) {
      madeProgress = false;

      for (const task of tasks) {
        if (!remaining.has(task.id)) {
          continue;
        }

        const dependsOn = task.dependsOn ?? [];
        if (dependsOn.length > 0) {
          const depResults = dependsOn.map(depId => executed.get(depId));

          // Если какая‑то из зависимостей ещё не выполнена — попробуем на следующем проходе.
          if (depResults.some(result => result === undefined)) {
            continue;
          }

          const hasFailedDependency = depResults.some(
            result => result && !result.success && !result.skipped,
          );

          if (hasFailedDependency) {
            remaining.delete(task.id);
            madeProgress = true;

            const skippedTask: MasTask = {
              ...task,
              status: 'skipped',
            };

            const step: ExecutionStepResult = {
              task: skippedTask,
              success: false,
              skipped: true,
              failureReason: 'dependency_failed',
              result: null,
              error:
                'Skipped because one or more dependencies failed.',
            };

            steps.push(step);
            executed.set(task.id, step);
            continue;
          }
        }

        // Все зависимости (если были) успешно завершены — выполняем задачу.
        remaining.delete(task.id);
        madeProgress = true;

        const rawStep = await executor.executeTask(task, context);

        const updatedTask: MasTask = {
          ...task,
          ...rawStep.task,
          status:
            rawStep.task.status ?? (rawStep.success ? 'completed' : 'failed'),
        };

        const normalizedStep: ExecutionStepResult = {
          ...rawStep,
          task: updatedTask,
        };

        steps.push(normalizedStep);
        executed.set(task.id, normalizedStep);
      }
    }

    // Задачи, которые так и не были подобраны — цикл или несостоятельные зависимости.
    if (remaining.size > 0) {
      for (const task of tasks) {
        if (!remaining.has(task.id)) {
          continue;
        }

        remaining.delete(task.id);

        const skippedTask: MasTask = {
          ...task,
          status: 'skipped',
        };

        const step: ExecutionStepResult = {
          task: skippedTask,
          success: false,
          skipped: true,
          failureReason: 'dependency_failed',
          result: null,
          error:
            'Skipped because dependencies could not be resolved (cycle or missing task).',
        };

        steps.push(step);
        executed.set(task.id, step);
      }
    }

    const updatedTasks: MasTask[] = tasks.map(task => {
      const step = executed.get(task.id);
      return step ? step.task : task;
    });

    const updatedPlan: MasTaskPlan = {
      ...plan,
      tasks: updatedTasks,
      metadata: {
        ...(plan.metadata ?? {}),
        executionStrategyType: this.type,
      },
    };

    const hasHardFailure = steps.some(
      step => !step.success && !step.skipped,
    );
    const success = steps.length > 0 && !hasHardFailure;

    const totalSkipped = steps.filter(step => step.skipped).length;
    const totalFailed = steps.filter(
      step => !step.success && !step.skipped,
    ).length;

    const reasons: Record<string, number> = {};
    for (const step of steps) {
      const reason =
        !step.success
          ? step.failureReason ??
            (step.skipped ? 'dependency_failed' : 'unknown')
          : step.failureReason;

      if (reason) {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
    }

    const failureSummary =
      totalFailed > 0 || totalSkipped > 0
        ? {
            totalFailed,
            totalSkipped,
            reasons,
          }
        : undefined;

    const metadata: ExecutionResultMetadata = {
      strategy: this.type,
      totalTasks: tasks.length,
      executedTasks: steps.filter(step => !step.skipped).length,
      skippedTasks: totalSkipped,
    };

    if (failureSummary) {
      metadata.failureSummary = failureSummary;
    }

    return {
      plan: updatedPlan,
      steps,
      success,
      metadata,
    };
  }
}