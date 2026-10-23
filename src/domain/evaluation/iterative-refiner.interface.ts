/**
 * IIterativeRefiner — Domain port for goal-driven iterative refinement.
 *
 * Combines IGoalEvaluator + IReflectionLoop to iteratively improve
 * output until it meets the goal's criteria or max iterations reached.
 *
 * @layer Domain (depends only on Core)
 * @see Book Ch.11 "Goal-Driven Agents" — Goal-Driven Iterative Refinement
 * @see IGoalEvaluator (src/domain/evaluation/goal-evaluator.interface.ts)
 * @see IReflectionLoop (src/domain/reasoning/reflection-loop.interface.ts)
 */

import type { CorrelationId } from '../../core/types/branded';
import type { GoalDefinition, GoalEvaluationResult } from './goal-evaluator.interface';

// ── Value Objects ────────────────────────────────────────────────────

/** Configuration for the iterative refinement process */
export interface RefinerConfig {
  /** Maximum number of refinement iterations */
  readonly maxIterations: number;
  /** Minimum score improvement per iteration to continue (avoids stagnation) */
  readonly improvementThreshold: number;
  /** Whether to use the reflection loop for improvement (vs. direct re-generation) */
  readonly useReflectionLoop: boolean;
}

/** Result of the iterative refinement process */
export interface RefinementResult {
  /** The final refined output */
  readonly finalOutput: string;
  /** Number of refinement iterations executed */
  readonly iterations: number;
  /** Score from the initial evaluation (before refinement) */
  readonly initialScore: number;
  /** Score from the final evaluation (after refinement) */
  readonly finalScore: number;
  /** All evaluation results (one per iteration) */
  readonly evaluations: readonly GoalEvaluationResult[];
  /** Whether the refinement converged (goal met or no further improvement) */
  readonly converged: boolean;
}

// ── Port Interface ──────────────────────────────────────────────────

/**
 * Goal-driven iterative refinement.
 * Combines IGoalEvaluator + IReflectionLoop to iteratively improve output.
 *
 * @see Book Ch.11 "Goal-Driven Agents" — Goal-Driven Iterative Refinement
 */
export interface IIterativeRefiner {
  /**
   * Iteratively refine output until it meets the goal criteria.
   *
   * Flow:
   * 1. Evaluate initial output against goal → GoalEvaluationResult
   * 2. If goal met → return immediately
   * 3. Use IReflectionLoop (or direct re-gen) to improve output using feedback
   * 4. Re-evaluate improved output
   * 5. Repeat until goal met, max iterations, or stagnation
   *
   * @param initialOutput — the starting content to refine
   * @param goal — structured goal with success criteria
   * @param config — refinement configuration
   * @param correlationId — request correlation ID for tracing
   * @returns Refinement result with all iterations and final output
   */
  refine(
    initialOutput: string,
    goal: GoalDefinition,
    config: RefinerConfig,
    correlationId: CorrelationId,
  ): Promise<RefinementResult>;
}
