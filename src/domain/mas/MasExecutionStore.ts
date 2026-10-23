/**
 * MAS Durable Execution - persistence interface.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Contract for durable storage of MAS task executions and their steps.
 * Implementations live in infrastructure layer (e.g. PostgresMasExecutionStore)
 * and MUST NOT leak infra details into domain.
 */
import type { MasTaskExecution } from './MasTaskExecution';
import type { MasTaskExecutionInit } from './MasTaskExecutionInit';
import type { MasExecutionStep } from './MasExecutionStep';
import type { MasStepStatusUpdate } from './MasStepStatusUpdate';
import type { MasExecutionError } from './MasExecutionError';
import type { MasRecoveryQuery } from './MasRecoveryQuery';

/**
 * MasExecutionStore is the single source of truth for durable execution
 * state. It is intentionally designed around domain DTOs and does not
 * depend on RequestContext or application-layer types.
 */
export interface MasExecutionStore {
  /**
   * Create a new durable task execution instance.
   *
   * Implementations should:
   * - persist MasTaskExecution with initial status (default: Pending);
   * - capture RequestContextSnapshot from init.requestContextSnapshot;
   * - initialize attempts = 0 and currentStepId = null;
   * - set createdAt / updatedAt.
   */
  startTaskExecution(init: MasTaskExecutionInit): Promise<MasTaskExecution>;

  /**
   * Load a single task execution by its durable identifier.
   */
  getTaskExecution(taskExecutionId: string): Promise<MasTaskExecution | null>;

  /**
   * Find active/running task executions that are candidates for recovery,
   * according to the provided query.
   *
   * Implementations MAY:
   * - pre-filter by task status / timeouts in the database;
   * - optionally limit results using query.maxTasks.
   */
  findActiveTasksForRecovery(
    query: MasRecoveryQuery,
  ): Promise<MasTaskExecution[]>;

  /**
   * Append a new durable step to an existing task execution.
   *
   * Contract:
   * - step.index should be assigned consistently (append-only);
   * - taskExecution.steps must reflect the newly appended step;
   * - currentStepId may be updated depending on status semantics.
   */
  appendStep(
    taskExecutionId: string,
    step: MasExecutionStep,
  ): Promise<MasTaskExecution>;

  /**
   * Apply a durable status transition and related metadata to an
   * existing step, returning the updated task execution aggregate.
   *
   * Implementations are responsible for:
   * - validating that the step belongs to the specified task;
   * - updating attempts / error / timestamps / resultRef as needed;
   * - updating taskExecution.status / currentStepId when appropriate
   *   (e.g. when all steps complete or a non-recoverable failure occurs).
   */
  updateStepStatus(
    update: MasStepStatusUpdate,
  ): Promise<MasTaskExecution>;

  /**
   * Mark the task execution as successfully completed at durable level.
   *
   * Implementations should:
   * - set status to Completed;
   * - clear lastError if it no longer applies;
   * - update updatedAt.
   */
  markTaskCompleted(taskExecutionId: string): Promise<MasTaskExecution>;

  /**
   * Mark the task execution as Failed with a durable error.
   *
   * Implementations should:
   * - set status to Failed;
   * - update lastError with the provided value;
   * - update updatedAt.
   */
  markTaskFailed(
    taskExecutionId: string,
    error: MasExecutionError,
  ): Promise<MasTaskExecution>;

  /**
   * Mark the task execution as Cancelled with a human-readable reason.
   *
   * Implementations MAY encode the reason into lastError.details or
   * taskExecution.meta, but the contract does not prescribe it.
   */
  markTaskCancelled(
    taskExecutionId: string,
    reason: string,
  ): Promise<MasTaskExecution>;
}