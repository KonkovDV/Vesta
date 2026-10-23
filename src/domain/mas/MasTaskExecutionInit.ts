/**
 * MAS Durable Execution - task execution initialization DTO.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Used by MasExecutionStore.startTaskExecution to create a new
 * durable task execution instance from MAS runtime inputs.
 */
import type { RequestContextSnapshot } from './RequestContextSnapshot';
import type { MasTaskStatus } from './MasTaskStatus';

export interface MasTaskExecutionInit {
  /**
   * Logical MAS task identifier (e.g. MasTask.id from the plan).
   */
  taskId: string;

  /**
   * MAS session identifier associated with this task execution
   * (typically MasSessionContext.masSessionId).
   */
  sessionId: string;

  /**
   * Minimal snapshot of the ambient RequestContext at the moment
   * the durable execution is created.
   */
  requestContextSnapshot: RequestContextSnapshot;

  /**
   * Optional initial durable status. If omitted, implementations
   * should default to MasTaskStatus.Pending.
   */
  status?: MasTaskStatus;

  /**
   * Optional timeouts for the task and its steps. If omitted,
   * implementations may rely on system/tenant defaults.
   */
  timeouts?: {
    taskTimeoutMs?: number;
    stepTimeoutMs?: number;
  };

  /**
   * Arbitrary metadata passed from MAS runtime / orchestrator.
   */
  meta?: Record<string, unknown>;
}