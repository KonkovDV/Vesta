/**
 * IGoalEvaluator — Domain port for goal-driven output evaluation.
 *
 * Evaluates LLM output against a structured goal with success criteria.
 * Delegates to ILlmJudge internally with goal-specific rubric.
 *
 * @layer Domain (depends only on Core)
 * @see Book Ch.11 "Goal-Driven Agents" — Goal Verification
 * @see ILlmJudge (src/domain/evaluation/llm-judge.interface.ts)
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Value Objects ────────────────────────────────────────────────────

/**
 * Structured goal definition with measurable success criteria.
 */
export interface GoalDefinition {
  /** The high-level goal description */
  readonly goal: string;
  /** Specific, measurable criteria that must be met */
  readonly successCriteria: readonly string[];
  /** Optional constraints the output must respect */
  readonly constraints?: readonly string[];
}

/**
 * Evaluation result against a goal.
 */
export interface GoalEvaluationResult {
  /** Whether the overall goal was met (overallScore >= threshold) */
  readonly goalMet: boolean;
  /** Per-criterion pass/fail results */
  readonly criteriaResults: Readonly<Record<string, boolean>>;
  /** Overall score (0-10 scale, weighted average) */
  readonly overallScore: number;
  /** Human-readable feedback from the judge */
  readonly feedback: string;
  /** Actionable suggestions for improvement */
  readonly suggestedImprovements: readonly string[];
}

// ── Port Interface ──────────────────────────────────────────────────

/**
 * Evaluates output against a defined goal with success criteria.
 * Delegates to ILlmJudge internally with goal-specific rubric.
 *
 * @see Book Ch.11 "Goal-Driven Agents"
 */
export interface IGoalEvaluator {
  /**
   * Evaluate output against the given goal definition.
   *
   * @param output — the LLM-generated content to evaluate
   * @param goal — structured goal with success criteria
   * @param correlationId — request correlation ID for tracing
   * @returns Goal evaluation result with per-criterion breakdown
   */
  evaluate(
    output: string,
    goal: GoalDefinition,
    correlationId: CorrelationId,
  ): Promise<GoalEvaluationResult>;
}
