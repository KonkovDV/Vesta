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
 * MAS-A3.2: Parallel execution strategy.
 *
 * Responsibilities:
 * - выполнять независимые задачи уровнями (topological waves);
 * - в рамках одного уровня запускать задачи параллельно через Promise.all;
 * - учитывать dependsOn и помечать зависимые задачи как skipped при
 *   неуспешных предшественниках.
 *
 * Ограничения MAS-A3.2:
 * - стратегия не управляет размерами пула, квотами и приоритетами;
 * - "параллельность" ограничивается Promise.all в пределах уровня.
 */
export class ParallelExecutionStrategy implements IExecutionStrategy {
  public readonly type = 'parallel' as const;

  public async executePlan(
    plan: MasTaskPlan,
    context: ExecutionStrategyContext,
    executor: TaskExecutor,
  ): Promise<ExecutionResult> {
    const tasks = plan.tasks ?? [];
    const steps: ExecutionStepResult[] = [];
    const executed = new Map<MasTaskId, ExecutionStepResult>();
    const remaining = new Set<MasTaskId>(tasks.map(task => task.id));

    let madeProgress = true;

    while (remaining.size > 0 && madeProgress) {
      madeProgress = false;

      const readyToRun: MasTask[] = [];
      const toSkip: MasTask[] = [];

      for (const task of tasks) {
        if (!remaining.has(task.id)) {
          continue;
        }

        const dependsOn = task.dependsOn ?? [];
        if (dependsOn.length > 0) {
          const depResults = dependsOn.map(depId => executed.get(depId));

          // Есть ещё не выполненные зависимости — оставим задачу на следующий раунд.
          if (depResults.some(result => result === undefined)) {
            continue;
          }

          const hasFailedDependency = depResults.some(
            result => result && !result.success && !result.skipped,
          );

          if (hasFailedDependency) {
            remaining.delete(task.id);
            madeProgress = true;
            toSkip.push(task);
            continue;
          }
        }

        // Все зависимости выполнены успешно — можно запускать на данном уровне.
        remaining.delete(task.id);
        madeProgress = true;
        readyToRun.push(task);
      }

      // 1) Помечаем задачи, которые нужно пропустить из‑за неуспешных зависимостей.
      for (const task of toSkip) {
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
      }

      // 2) Выполняем все готовые задачи параллельно.
      if (readyToRun.length > 0) {
        const levelPromises = readyToRun.map(task => executor.executeTask(task, context));
        const levelResults = await Promise.allSettled(levelPromises);
 
        for (let index = 0; index < levelResults.length; index++) {
          const task = readyToRun[index];
          const settled = levelResults[index];
 
          if (settled.status === 'fulfilled') {
            const rawStep = settled.value;
 
            const updatedTask: MasTask = {
              ...task,
              ...rawStep.task,
              status:
                rawStep.task.status ??
                (rawStep.success ? 'completed' : 'failed'),
            };
 
            const normalizedStep: ExecutionStepResult = {
              ...rawStep,
              task: updatedTask,
            };
 
            executed.set(task.id, normalizedStep);
            steps.push(normalizedStep);
          } else {
            const failedTask: MasTask = {
              ...task,
              status: 'failed',
            };
 
            const step: ExecutionStepResult = {
              task: failedTask,
              success: false,
              skipped: false,
              failureReason: 'executor_error',
              result: null,
              error: settled.reason,
            };
 
            executed.set(task.id, step);
            steps.push(step);
          }
        }
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