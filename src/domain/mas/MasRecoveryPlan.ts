/**
 * MAS Durable Execution - recovery plan DTO.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Represents the result of analysing stuck / timed-out task executions
 * and the set of actions that should be applied by recovery workers.
 */
import type { MasRecoveryQuery } from './MasRecoveryQuery';
import type { MasExecutionError } from './MasExecutionError';
import type { MasTaskStatus } from './MasTaskStatus';
import type { MasExecutionStatus } from './MasExecutionStatus';

export type MasRecoveryTaskActionType =
  | 'mark_failed'
  | 'mark_dead_lettered'
  | 'cancel';

export type MasRecoveryStepActionType =
  | 'retry'
  | 'mark_failed'
  | 'mark_dead_lettered';

export interface MasRecoveryTaskAction {
  /**
   * Identifier of the affected task execution.
   */
  taskExecutionId: string;

  /**
   * Planned action at task level.
   */
  action: MasRecoveryTaskActionType;

  /**
   * Optional durable error to be recorded on the task when
   * marking it as Failed / DeadLettered.
   */
  error?: MasExecutionError;

  /**
   * Optional reason code for observability / diagnostics
   * (e.g. "TASK_TIMEOUT", "MAX_STEP_RETRIES_EXCEEDED").
   */
  reasonCode?: string;

  /**
   * Current known task status when the plan was generated.
   */
  currentStatus?: MasTaskStatus;
}

export interface MasRecoveryStepAction {
  /**
   * Identifier of the parent task execution.
   */
  taskExecutionId: string;

  /**
   * Identifier of the affected step.
   */
  stepId: string;

  /**
   * Planned action at step level.
   */
  action: MasRecoveryStepActionType;

  /**
   * Optional durable error to be recorded on the step when
   * marking it as Failed / DeadLettered.
   */
  error?: MasExecutionError;

  /**
   * Optional reason code for observability / diagnostics
   * (e.g. "STEP_TIMEOUT", "HEARTBEAT_MISSED").
   */
  reasonCode?: string;

  /**
   * Current known step status when the plan was generated.
   */
  currentStatus?: MasExecutionStatus;
}

export interface MasRecoveryPlanSummary {
  /**
   * Number of task executions that were inspected during analysis.
   */
  tasksInspected: number;

  /**
   * Number of steps that were inspected across all tasks.
   */
  stepsInspected: number;

  /**
   * Total number of planned actions (task-level + step-level).
   */
  actionsPlanned: number;

  tasksMarkedFailed: number;
  tasksMarkedDeadLettered: number;
  tasksCancelled: number;

  stepsScheduledForRetry: number;
  stepsMarkedFailed: number;
  stepsMarkedDeadLettered: number;
}

export interface MasRecoveryPlan {
  /**
   * Original query parameters that produced this plan.
   */
  query: MasRecoveryQuery;

  /**
   * Planned task-level actions.
   */
  taskActions: MasRecoveryTaskAction[];

  /**
   * Planned step-level actions.
   */
  stepActions: MasRecoveryStepAction[];

  /**
   * High-level summary for observability and testing.
   */
  summary: MasRecoveryPlanSummary;

  /**
   * Timestamp when this plan was generated.
   */
  generatedAt: Date;

  /**
   * Optional label propagated from the query (e.g. "scheduler",
   * "manual", "tenant_job") for metrics and logging.
   */
  sourceLabel?: string;
}