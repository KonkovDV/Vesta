/**
 * IReflectionLoop — Domain port for iterative Generate→Reflect→Refine loops.
 *
 * Pattern: Each iteration calls LLM to generate, then reflect on output.
 * If reflection approves OR sentinel token found → stop.
 * Stateless mode prevents critique drift by starting fresh context each time.
 *
 * @layer Domain (port contract)
 * @see Book Ch.4 "Reflection" — iterative generate→reflect→refine (pp.75-92)
 * @see Book Ch.17 "Reasoning" — self-correction variant
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Configuration for a reflection loop execution.
 */
export interface ReflectionConfig {
  /** Maximum number of generate→reflect iterations. Default 3. */
  readonly maxIterations: number;
  /** If present in reflection output, loop stops immediately. E.g., "CODE_IS_PERFECT". */
  readonly sentinelToken?: string;
  /** true = new LLM context per iteration (prevents memory/critique drift). */
  readonly stateless: boolean;
  /** Per-iteration timeout in ms. */
  readonly timeoutMs?: number;
}

/**
 * Result of a single iteration within the reflection loop.
 */
export interface ReflectionIteration {
  /** 1-based iteration number. */
  readonly iterationNumber: number;
  /** Content generated in this iteration. */
  readonly generatedContent: string;
  /** Reflection/critique of the generated content. */
  readonly reflection: string;
  /** Whether the loop should continue or stop after this iteration. */
  readonly action: 'continue' | 'stop';
  /** Whether the sentinel token was found in the reflection output. */
  readonly sentinelMatched: boolean;
}

/**
 * Final result of the complete reflection loop execution.
 */
export interface ReflectionResult {
  /** Best content produced (from the last iteration). */
  readonly finalContent: string;
  /** All iterations for audit trail. Append-only, immutable. */
  readonly iterations: readonly ReflectionIteration[];
  /** Total number of iterations executed. */
  readonly totalIterations: number;
  /** What caused the loop to terminate. */
  readonly stoppedBy: 'sentinel' | 'max_iterations' | 'approved';
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * Iterative Generate→Reflect→Refine loop.
 *
 * Used by:
 *   - ISelfCorrectionAgent (Ch.17) — code/reasoning self-correction
 *   - IIterativeRefiner (Ch.11)    — goal-driven iterative improvement
 *
 * @see DI_TOKENS.IReflectionLoop
 */
export interface IReflectionLoop {
  /**
   * Execute generate→reflect→refine loop until convergence or max iterations.
   *
   * @param task            — Original task/prompt describing what to generate
   * @param initialContent  — Starting content (empty string for first generation)
   * @param config          — Loop configuration (max iterations, sentinel, stateless mode)
   * @param correlationId   — Request correlation ID for tracing
   * @returns Final content + iteration audit trail
   */
  execute(
    task: string,
    initialContent: string,
    config: ReflectionConfig,
    correlationId: CorrelationId,
  ): Promise<ReflectionResult>;
}
