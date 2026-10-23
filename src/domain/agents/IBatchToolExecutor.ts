/**
 * Batch Tool Executor — pipelined execution of multiple tool calls.
 *
 * Enables agents to execute N tool calls in a single orchestration step
 * with dependency graph resolution, early termination on errors, and
 * conditional chaining (if/else between calls). Reduces round-trip
 * overhead by ~37% input tokens (Anthropic PTC benchmark, Sep 2025).
 *
 * @layer Domain (port)
 * @module agents
 * @pattern CC-005 Programmatic Tool Calling / Batch Execution (FITNESS-K: 81.0)
 * @see src/domain/agents/tools.interface.ts — IToolRegistry (single-call execution)
 * @see src/domain/security/tool-execution-policy.interface.ts — per-call policy
 * @see src/domain/finops/ITokenomicsController.ts — cost tracking for batches
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Batch Call Definition ──────────────────────────────────────────

/**
 * Priority level for batch execution ordering.
 */
export type BatchPriority = 'sequential' | 'parallel' | 'conditional';

/**
 * A single tool call within a batch.
 */
export interface BatchToolCall {
  /** Unique call ID within the batch (for dependency references). */
  readonly callId: string;
  /** Tool name (must exist in IToolRegistry). */
  readonly toolName: string;
  /** Arguments to pass to the tool. */
  readonly args: Record<string, unknown>;
  /**
   * Dependency: IDs of calls that must complete before this one.
   * Empty array or omitted = no dependencies (can run in parallel).
   */
  readonly dependsOn?: ReadonlyArray<string>;
  /**
   * Optional condition: execute only if the referenced call succeeded.
   * Format: callId of the prerequisite call.
   */
  readonly conditionalOn?: string;
  /** Maximum time for this individual call (ms). */
  readonly timeoutMs?: number;
}

/**
 * Complete batch execution request.
 */
export interface BatchExecutionRequest {
  /** Unique batch ID. */
  readonly batchId: string;
  /** Agent ID submitting the batch. */
  readonly agentId: string;
  /** Ordered list of tool calls (topologically sorted by dependsOn). */
  readonly calls: ReadonlyArray<BatchToolCall>;
  /** Stop entire batch on first error? Default: true. */
  readonly failFast?: boolean;
  /** Maximum total batch duration (ms). */
  readonly maxBatchDurationMs?: number;
}

// ── Batch Results ──────────────────────────────────────────────────

/**
 * Outcome of a single call within a batch.
 */
export type BatchCallOutcome = 'success' | 'error' | 'skipped' | 'timeout';

/**
 * Result of a single tool call within a batch.
 */
export interface BatchCallResult {
  /** Matches BatchToolCall.callId. */
  readonly callId: string;
  /** Tool that was called. */
  readonly toolName: string;
  /** Outcome of this call. */
  readonly outcome: BatchCallOutcome;
  /** Tool output (if success). */
  readonly output?: unknown;
  /** Error message (if error/timeout). */
  readonly error?: string;
  /** Execution duration (ms). */
  readonly durationMs: number;
}

/**
 * Aggregate outcome of the entire batch.
 */
export type BatchOutcome =
  | 'all_succeeded'
  | 'partial'
  | 'all_failed'
  | 'aborted';

/**
 * Final result of a batch execution.
 */
export interface BatchExecutionResult {
  /** Matches BatchExecutionRequest.batchId. */
  readonly batchId: string;
  /** Aggregate outcome. */
  readonly outcome: BatchOutcome;
  /** Per-call results, ordered by execution sequence. */
  readonly results: ReadonlyArray<BatchCallResult>;
  /** Total batch wall-clock time (ms). */
  readonly totalDurationMs: number;
  /** Number of calls that succeeded. */
  readonly succeededCount: number;
  /** Number of calls that failed. */
  readonly failedCount: number;
  /** Number of calls skipped (due to failFast or unmet conditions). */
  readonly skippedCount: number;
}

// ── Batch Policy Decision ──────────────────────────────────────────

/**
 * Policy evaluation result for an entire batch.
 * Extends the single-call IToolExecutionPolicy to batch context.
 */
export interface BatchPolicyDecision {
  /** Whether the batch as a whole is authorized. */
  readonly allowed: boolean;
  /** Per-call decisions (tools that need individual approval). */
  readonly callDecisions: ReadonlyArray<{
    readonly callId: string;
    readonly decision: 'allow' | 'ask' | 'deny';
    readonly reason?: string;
  }>;
  /** Rejected call IDs (if any). */
  readonly rejectedCallIds: ReadonlyArray<string>;
}

// ── Batch Tool Executor Port ───────────────────────────────────────

/**
 * Domain port for batch tool execution with dependency resolution.
 *
 * Executes multiple tool calls in a single orchestration step,
 * respecting dependency ordering, conditional branching, and
 * fail-fast semantics.
 *
 * @pattern CC-005 PTC Batch Execution — ~37% token reduction
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IBatchToolExecutor {
  /**
   * Execute a batch of tool calls with dependency resolution.
   * @param request - Batch definition with calls and configuration.
   * @param correlationId - Request correlation for tracing.
   * @returns Aggregate batch result.
   */
  executeBatch(
    request: BatchExecutionRequest,
    correlationId: CorrelationId,
  ): Promise<BatchExecutionResult>;

  /**
   * Evaluate batch-level policy (pre-flight authorization).
   * Checks each call against IToolExecutionPolicy.evaluate().
   * @param request - Batch to evaluate.
   * @param correlationId - Request correlation for tracing.
   * @returns Per-call and aggregate policy decisions.
   */
  evaluateBatchPolicy(
    request: BatchExecutionRequest,
    correlationId: CorrelationId,
  ): Promise<BatchPolicyDecision>;

  /**
   * Abort a running batch.
   * @param batchId - Batch to abort.
   * @param correlationId - Request correlation for tracing.
   */
  abortBatch(batchId: string, correlationId: CorrelationId): Promise<void>;
}
