/**
 * MAS Durable Execution - recovery query DTO.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Describes how MasRecoveryService / MasExecutionStore should select
 * candidates (tasks/steps) for recovery.
 */
import type { MasTaskStatus } from './MasTaskStatus';
import type { MasExecutionStatus } from './MasExecutionStatus';

export interface MasRecoveryQuery {
  /**
   * Optional upper bound for the number of task executions to inspect
   * in a single recovery pass.
   */
  maxTasks?: number;

  /**
   * Optional upper bound for the number of steps to inspect per task.
   */
  maxStepsPerTask?: number;

  /**
   * Candidate task statuses that are considered for recovery.
   * If omitted, implementations should default to ['Running'].
   */
  taskStatuses?: MasTaskStatus[];

  /**
   * Candidate step statuses that are considered "stuck" or otherwise
   * eligible for recovery.
   *
   * Typical values: ['InProgress', 'Blocked'].
   */
  stepStatuses?: MasExecutionStatus[];

  /**
   * Tasks whose updatedAt is strictly earlier than this timestamp
   * are considered stale and eligible for inspection.
   */
  updatedBefore?: Date;

  /**
   * Steps whose lastHeartbeatAt (or startedAt when heartbeat is absent)
   * is strictly earlier than this timestamp are considered stuck.
   */
  stepLastHeartbeatBefore?: Date;

  /**
   * Optional task-level timeout override for this recovery pass
   * (in milliseconds). If provided, it can be used as an additional
   * guard even when task.timeouts.taskTimeoutMs is not set.
   */
  taskTimeoutOverrideMs?: number;

  /**
   * Optional step-level timeout override for this recovery pass
   * (in milliseconds). If provided, it can be used as an additional
   * guard even when timeouts.stepTimeoutMs is not set.
   */
  stepTimeoutOverrideMs?: number;

  /**
   * Filter by session identifier (e.g. per-tenant or per-user recovery
   * jobs that operate on a subset of sessions).
   */
  sessionIdEquals?: string;

  /**
   * Optional free-form label to tag metrics / events emitted as part
   * of this recovery run (e.g. "scheduler", "manual", "tenant_job").
   */
  sourceLabel?: string;

  /**
   * Arbitrary metadata bag for infra-specific filters (shard id,
   * worker group, region, etc.).
   */
  meta?: Record<string, unknown>;
}