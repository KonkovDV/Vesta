/**
 * MAS Runtime Core - execution strategy contracts.
 *
 * Layer: Application (business orchestration).
 *
 * Responsibilities:
 * - define abstractions for executing MasTaskPlan instances produced by ITaskDecomposer;
 * - describe minimal configuration/diagnostics contracts for execution strategies;
 * - provide DI token for pluggable strategy implementations.
 *
 * IMPORTANT:
 * - IExecutionStrategy is responsible only for orchestration of MAS tasks
 *   (task ordering, scheduling, and, in future, agent/memory calls).
 * - It MUST NOT implement or depend on:
 *   - policy evaluation / Policy Engine;
 *   - plugin sandboxing / tool sandboxes;
 *   - Outbox or low-level event transport.
 *   Those concerns belong to dedicated services in other layers.
 */

import type {
  MasTask,
  MasTaskPlan,
  MasSessionContext,
  MasRequest,
  ExecutionStrategyType as MasExecutionStrategyType,
  MasMetadataBag,
} from '../types/mas-types';

/**
 * Canonical execution strategy type used across MAS Runtime.
 *
 * NOTE:
 * - This is an alias to ExecutionStrategyType defined in mas-types.ts to keep
 *   public contracts (MasRequest.strategy, etc.) centralized in one place.
 */
export type ExecutionStrategyType = MasExecutionStrategyType;

/**
 * Immutable execution context passed to strategies.
 */
export interface ExecutionStrategyContext {
  /** Исходный запрос MAS, может использоваться для логики стратегии. */
  request: MasRequest;
  /** Текущая MAS-сессия. */
  session: MasSessionContext;
}

/**
 * Result of a single executed task within a plan.
 */
export interface ExecutionStepResult {
  /**
   * Task snapshot after execution (with updated status/metadata).
   * Implementations SHOULD avoid mutating the original task objects and instead
   * clone them when updating status/metadata.
   */
  task: MasTask;
  /** true, если задача завершилась успешно. */
  success: boolean;
  /** Произвольный результат, сформированный исполнителем задачи. */
  result: unknown;
  /**
   * Ошибка выполнения или причина, по которой задача не была запущена
   * (например, из-за несостоявшихся зависимостей).
   */
  error?: unknown;
  /**
   * true, если задача была намеренно пропущена (skipped) без вызова TaskExecutor,
   * например, из-за того, что одна из зависимостей завершилась с ошибкой
   * или не может быть разрешена.
   *
   * Инварианты:
   * - skipped === true ⇒ success === false и TaskExecutor для задачи не вызывался.
   */
  skipped?: boolean;
  /**
   * Нормализованная причина неуспешного завершения шага.
   *
   * Семантика:
   * - 'dependency_failed' — задача не запускалась, т.к. одна из зависимостей
   *   завершилась с ошибкой или была помечена как failed;
   * - 'timeout' — TaskExecutor пометил задачу как истёкшую по таймауту;
   * - 'executor_error' — исполнитель задачи выбросил исключение/вернул ошибку;
  * - 'approval_required' — шаг остановлен до выполнения и ждёт внешнего одобрения;
   * - 'unknown' — причина неуспеха не была нормализована.
   *
   * Инварианты:
   * - success === true ⇒ skipped !== true и failureReason не задан;
   * - skipped === true ⇒ success === false;
   * - при timeout или исключении исполнителя:
   *   - success === false,
   *   - skipped !== true,
   *   - failureReason выставляется ('timeout' или 'executor_error').
   */
  failureReason?: 'dependency_failed' | 'timeout' | 'executor_error' | 'approval_required' | 'unknown';
  /**
   * Фактическая продолжительность выполнения шага в миллисекундах (если известна).
   * Для задач, помеченных как skipped до вызова TaskExecutor, может быть не задана.
   */
  durationMs?: number;
}

/**
 * Aggregated statistics about failed and skipped tasks in a plan.
 */
export interface ExecutionFailureSummary {
  /** Количество задач, завершившихся с ошибкой (success === false, skipped !== true). */
  totalFailed: number;
  /** Количество задач, помеченных как skipped. */
  totalSkipped: number;
  /**
   * Количество задач по каждой нормализованной причине неуспеха (failureReason).
   * Ключи соответствуют значениям ExecutionStepResult.failureReason.
   */
  reasons: Record<string, number>;
}

/**
 * Standard metadata bag returned by execution strategies.
 */
export interface ExecutionResultMetadata extends MasMetadataBag {
  /**
   * Агрегированная информация о неуспешных/пропущенных задачах.
   * Может отсутствовать, если все задачи успешно выполнены.
   */
  failureSummary?: ExecutionFailureSummary;
}

/**
 * Aggregated result of executing a MasTaskPlan.
 */
export interface ExecutionResult {
  /**
   * План после выполнения с обновлёнными задачами (статусы/метаданные).
   * Входной план должен рассматриваться как неизменяемый.
   */
  plan: MasTaskPlan;
  /**
   * Последовательность шагов выполнения в порядке, выбранном стратегией.
   *
   * Важно:
   * - порядок в steps отражает фактический порядок запусков/решений по задачам;
   * - для параллельных стратегий порядок завершения Promises не обязан
   *   совпадать с порядком в steps.
   */
  steps: ExecutionStepResult[];
  /**
   * true, если все задачи, которые стратегия посчитала обязательными к выполнению,
   * завершились успешно или были помечены как skipped (degraded execution).
   *
   * На MAS-A3.3 этапе:
   * - любая задача с success === false и skipped !== true ⇒ ExecutionResult.success = false;
   * - skipped-задачи трактуются как деградация, но не как "жёсткий" фейл плана.
   */
  success: boolean;
  /** Дополнительные метаданные (агрегация, отладка, диагностика). */
  metadata?: ExecutionResultMetadata;
}

/**
 * Абстракция единичного исполнения MasTask.
 *
 * Реализация находится в MasterAgentV1 (или специализированных исполнителях)
 * и скрывает от стратегий все детали про агентов, LLM, инструменты, Memory и т.п.
 */
export interface TaskExecutor {
  executeTask(
    task: MasTask,
    context: ExecutionStrategyContext,
  ): Promise<ExecutionStepResult>;
}

/**
 * Execution strategy abstraction for MAS task plans.
 *
 * Responsibilities:
 * - orchestrate execution of MasTaskPlan (ordering, scheduling, fan-out);
 * - coordinate вызовы TaskExecutor в соответствии с зависимостями dependsOn.
 *
 * Non-responsibilities (MUST be handled elsewhere):
 * - Policy Engine / authorization decisions;
 * - plugin sandboxing / tool isolation;
 * - Outbox / event transport / low-level persistence.
 */
export interface IExecutionStrategy {
  /**
   * Static type identifier of the strategy (sequential/parallel/hybrid/etc.).
   */
  readonly type: ExecutionStrategyType;

  /**
   * Execute the provided MAS task plan within the given MAS context.
   *
   * Implementations MUST:
   * - treat input plan/session/request as immutable;
   * - not mutate ExecutionStrategyContext;
   * - return a new ExecutionResult instance on each call;
   * - never call TaskExecutor for tasks whose dependencies are not satisfied.
   */
  executePlan(
    plan: MasTaskPlan,
    context: ExecutionStrategyContext,
    executor: TaskExecutor,
  ): Promise<ExecutionResult>;
}

/**
 * DI token for resolving the default IExecutionStrategy implementation.
 *
 * NOTE:
 * - The canonical registration lives in the infrastructure DI bootstrap:
 *   [`src/infrastructure/di/bootstrap.ts`](src/infrastructure/di/bootstrap.ts:493).
 */
export const executionStrategyToken = 'IExecutionStrategy' as const;
export type ExecutionStrategyDiToken = typeof executionStrategyToken;