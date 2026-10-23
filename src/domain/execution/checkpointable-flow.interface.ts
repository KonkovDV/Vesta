/**
 * ICheckpointableFlow — Domain interface for checkpoint/resume in multi-step flows.
 *
 * Enables crash recovery for long-running agentic pipelines by saving
 * intermediate state at each step. On failure, the flow can resume from
 * the last successful checkpoint instead of restarting from scratch.
 *
 * Integrated by: IPromptChainExecutor (per-step), IDeepResearchService (per-search).
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.12 "Exception Handling and Recovery" — checkpoint/resume
 * @see CC-11 (Master Plan §8.11)
 */

import type { CorrelationId } from '@/ai-types';

/**
 * Snapshot of flow state at a given step.
 */
export interface FlowCheckpoint {
  readonly flowId: string;
  readonly stepIndex: number;
  readonly state: Record<string, unknown>;
  readonly timestamp: number;
}

/**
 * Checkpoint-based crash recovery for multi-step flows.
 * Lifecycle: singleton.
 */
export interface ICheckpointableFlow {
  /** Save a checkpoint for a flow at the current step. */
  saveCheckpoint(
    checkpoint: FlowCheckpoint,
    correlationId: CorrelationId,
  ): Promise<void>;

  /** Load the latest checkpoint for a flow (null if none). */
  loadCheckpoint(
    flowId: string,
    correlationId: CorrelationId,
  ): Promise<FlowCheckpoint | null>;

  /** Resume execution from a checkpoint (marks as resumed). */
  resumeFromCheckpoint(
    checkpoint: FlowCheckpoint,
    correlationId: CorrelationId,
  ): Promise<void>;

  /** Delete all checkpoints for a completed flow. */
  clearCheckpoints(
    flowId: string,
    correlationId: CorrelationId,
  ): Promise<void>;
}
