/**
 * MAS Durable Execution - execution step value object.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Represents a single durable step within a MAS task execution.
 * It is a pure data structure; all persistence and side‑effects
 * are handled by MasExecutionStore and infrastructure layer.
 */
import type { MasExecutionStepKind } from './MasExecutionStepKind';
import type { MasExecutionStatus } from './MasExecutionStatus';
import type { MasResultRef } from './MasResultRef';
import type { MasExecutionError } from './MasExecutionError';
import type { MasMemoryPolicy } from './MasMemoryPolicy';

export interface MasExecutionStep {
  /**
   * Unique identifier of this step within the durable execution store.
   */
  stepId: string;

  /**
   * Identifier of the parent task execution aggregate.
   */
  taskExecutionId: string;

  /**
   * Zero-based index of the step inside taskExecution.steps.
   * Implementations should keep this index stable for a given step.
   */
  index: number;

  /**
   * Logical kind of step (LLM, TOOL, SUB_AGENT, etc.).
   */
  kind: MasExecutionStepKind;

  /**
   * Current durable execution status of this step.
   */
  status: MasExecutionStatus;

  /**
   * How many attempts to execute this step have already been made
   * (including the current one, if any).
   */
  attempts: number;

  /**
   * Optional maximum attempts allowed for this step. When attempts
   * reaches this value, recovery logic should stop retrying and mark
   * the step as Failed/DeadLettered at task level.
   */
  maxAttempts?: number;

  /**
   * Idempotency key used to detect duplicate/replayed executions
   * at the orchestration / infrastructure layer.
   */
  idempotencyKey: string;

  /**
   * Snapshot of the input parameters for this step. Kept as opaque
   * JSON‑serializable structure.
   */
  inputSnapshot: unknown;

  /**
   * Optional reference to the materialized result stored in external
   * systems (event store, memory, tracing, etc.).
   */
  resultRef?: MasResultRef;

  /**
   * Optional durable error associated with the step when it failed
   * or was blocked/cancelled.
   */
  error?: MasExecutionError;

  /**
   * Timestamps for basic lifecycle instrumentation.
   */
  startedAt?: Date;
  completedAt?: Date;
  lastHeartbeatAt?: Date;

  /**
   * Memory persistence policy for this step result.
   */
  memoryPolicy?: MasMemoryPolicy;

  /**
   * Optional reference to a policy engine decision that affected
   * the execution of this step (e.g. governance, quotas, sanctions).
   */
  policyDecisionRef?: string;
}