/**
 * Autonomous Execution Loop — bounded iterative agent execution.
 *
 * Implements the "Ralph Wiggum" pattern: an agent iterates through
 * check→execute→verify cycles with hard budget/time/iteration bounds.
 * Integrates with ITokenomicsController for cost tracking and
 * ICheckpointableFlow for crash recovery.
 *
 * @layer Domain (port)
 * @module agents
 * @pattern CC-009 Autonomous Execution Loop (FITNESS-K: 82.5)
 * @see src/domain/execution/agent-budget.interface.ts — per-agent budget
 * @see src/domain/finops/ITokenomicsController.ts — FinOps cost governance
 * @see src/domain/execution/checkpointable-flow.interface.ts — checkpoint/resume
 * @see src/domain/agents/tool-loop-detector.port.ts — infinite loop detection
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Loop Bounds ────────────────────────────────────────────────────

/**
 * Hard boundary constraints for an autonomous execution loop.
 * Any exceeded bound triggers graceful termination.
 */
export interface LoopBounds {
  /** Maximum iterations before forced stop. */
  readonly maxIterations: number;
  /** Maximum wall-clock duration in milliseconds. */
  readonly maxDurationMs: number;
  /** Maximum cumulative cost in USD (integrates with ITokenomicsController). */
  readonly maxBudgetUsd: number;
  /** Minimum meaningful progress per N iterations (0.0–1.0). Below → stall escalation. */
  readonly progressThreshold?: number;
  /** Number of consecutive no-progress iterations before stall escalation. Default: 3. */
  readonly stallWindowSize?: number;
}

// ── Iteration State ────────────────────────────────────────────────

/**
 * Snapshot of a single iteration within the autonomous loop.
 */
export interface IterationSnapshot {
  /** 0-based iteration index. */
  readonly iterationIndex: number;
  /** Wall-clock time elapsed since loop start (ms). */
  readonly elapsedMs: number;
  /** Cumulative cost incurred so far (USD). */
  readonly cumulativeCostUsd: number;
  /** Progress delta from the previous iteration (0.0–1.0). */
  readonly progressDelta: number;
  /** Optional output/artifact produced by this iteration. */
  readonly output?: unknown;
  /** Whether this iteration produced meaningful progress. */
  readonly isProgressing: boolean;
}

/**
 * Runtime context passed into a single autonomous loop iteration callback.
 */
export interface LoopIterationContext {
  /** 0-based iteration index. */
  readonly iterationIndex: number;
  /** Previous iteration output, or the initial input on the first iteration. */
  readonly previousOutput: unknown;
  /** Elapsed wall-clock time before this iteration starts. */
  readonly elapsedMs: number;
  /** Cumulative cost before this iteration starts. */
  readonly cumulativeCostUsd: number;
  /** Correlation ID for tracing. */
  readonly correlationId: CorrelationId;
}

/**
 * Result produced by a single loop iteration callback.
 */
export interface LoopIterationResult {
  /** Output/artifact produced by the iteration. */
  readonly output?: unknown;
  /** Progress delta for this iteration (0.0-1.0). */
  readonly progressDelta?: number;
  /** Whether the iteration made meaningful progress. */
  readonly isProgressing?: boolean;
  /** Optional explicit cost override for the iteration (USD). */
  readonly costUsd?: number;
  /** Whether the task is fully completed and the loop should stop successfully. */
  readonly completed?: boolean;
}

// ── Termination ────────────────────────────────────────────────────

/**
 * Reason the autonomous loop terminated.
 */
export type LoopTerminationReason =
  | 'completed'
  | 'max_iterations'
  | 'max_duration'
  | 'budget_exhausted'
  | 'stall_detected'
  | 'external_abort'
  | 'error';

/**
 * Final result of the autonomous execution loop.
 */
export interface LoopExecutionResult {
  /** Why the loop terminated. */
  readonly terminationReason: LoopTerminationReason;
  /** Total iterations executed. */
  readonly totalIterations: number;
  /** Wall-clock total duration (ms). */
  readonly totalDurationMs: number;
  /** Total cost incurred (USD). */
  readonly totalCostUsd: number;
  /** All iteration snapshots (for audit/replay). */
  readonly iterations: ReadonlyArray<IterationSnapshot>;
  /** Final output (last successful iteration output). */
  readonly finalOutput?: unknown;
  /** Error details if terminationReason === 'error'. */
  readonly error?: string;
}

// ── Loop Task ──────────────────────────────────────────────────────

/**
 * A task definition fed into the autonomous loop.
 */
export interface LoopTask {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Human-readable task description. */
  readonly description: string;
  /** Initial input/payload for the first iteration. */
  readonly initialInput: unknown;
  /** Agent ID executing this loop. */
  readonly agentId: string;
  /** Hard bounds for this execution. */
  readonly bounds: LoopBounds;
  /**
   * Optional real iteration callback.
   * When omitted, adapters may fall back to synthetic/stub iteration behavior.
   */
  readonly executeIteration?: (
    context: LoopIterationContext,
  ) => Promise<LoopIterationResult>;
}

// ── Stall Detector ─────────────────────────────────────────────────

/**
 * Stall detection result — tracks whether the loop is making progress.
 * Separated from IToolLoopDetector which handles tool-call loops.
 */
export interface StallDetectionResult {
  /** Whether a stall is detected. */
  readonly isStalled: boolean;
  /** Number of consecutive no-progress iterations. */
  readonly consecutiveStalls: number;
  /** Recommended action when stalled. */
  readonly recommendation: 'continue' | 'escalate' | 'abort';
}

/**
 * Stall detection port — monitors iteration progress deltas.
 *
 * @pattern CC-009 sub-component: progress-delta tracking
 */
export interface IStallDetector {
  /**
   * Evaluate whether the loop has stalled based on recent iterations.
   * @param snapshots - Recent iteration snapshots (ordered by index).
   * @param bounds - Loop bounds containing progressThreshold and stallWindowSize.
   */
  detectStall(
    snapshots: ReadonlyArray<IterationSnapshot>,
    bounds: LoopBounds,
  ): StallDetectionResult;
}

// ── Autonomous Execution Loop Port ─────────────────────────────────

/**
 * Domain port for bounded autonomous agent execution.
 *
 * The loop executes iteratively until either the task completes
 * or any bound (iterations, time, cost, stall) is exceeded.
 * Each iteration is checkpointable for crash recovery.
 *
 * @pattern CC-009 Ralph Wiggum Pattern — bounded self-supervised loop
 */
export interface IAutonomousExecutionLoop {
  /**
   * Execute a task in a bounded autonomous loop.
   * @param task - Task definition with bounds.
   * @param correlationId - Request correlation for tracing.
   * @returns Final execution result with termination reason and all snapshots.
   */
  run(task: LoopTask, correlationId: CorrelationId): Promise<LoopExecutionResult>;

  /**
   * Abort a running loop externally (e.g., user cancellation, HITL override).
   * @param taskId - The task to abort.
   * @param correlationId - Request correlation for tracing.
   */
  abort(taskId: string, correlationId: CorrelationId): Promise<void>;

  /**
   * Query the current state of a running loop.
   * @param taskId - The task to inspect.
   * @returns Latest iteration snapshot or null if not running.
   */
  getStatus(taskId: string): IterationSnapshot | null;
}
