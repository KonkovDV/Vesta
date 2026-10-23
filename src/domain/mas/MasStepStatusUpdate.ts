/**
 * MAS Durable Execution - step status update DTO.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Used by MasExecutionStore.updateStepStatus() to apply a durable
 * status transition and related metadata to an existing step.
 */
import type { MasExecutionStatus } from './MasExecutionStatus';
import type { MasExecutionError } from './MasExecutionError';
import type { MasResultRef } from './MasResultRef';

export interface MasStepStatusUpdate {
  /**
   * Identifier of the parent task execution aggregate.
   */
  taskExecutionId: string;

  /**
   * Identifier of the step being updated.
   */
  stepId: string;

  /**
   * New durable execution status for the step.
   */
  status: MasExecutionStatus;

  /**
   * Optional updated attempts counter at step level. When omitted,
   * the store implementation may increment attempts automatically
   * based on previous value and status transition.
   */
  attempts?: number;

  /**
   * Optional durable error associated with this status transition.
   * May be set to null to explicitly clear error for recovery flows.
   */
  error?: MasExecutionError | null;

  /**
   * Optional reference to the external result materialized for
   * this step (event store record, memory pointer, trace id, etc.).
   */
  resultRef?: MasResultRef;

  /**
   * Optional heartbeat timestamp for liveness tracking.
   */
  lastHeartbeatAt?: Date;

  /**
   * Optional completion timestamp when the step reaches a
   * terminal status (Completed / Failed / Cancelled / Skipped).
   */
  completedAt?: Date;

  /**
   * Free-form metadata bag for infra-level details (worker id,
   * shard id, retry reason, etc.).
   */
  meta?: Record<string, unknown>;
}