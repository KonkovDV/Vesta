/**
 * ILlmJudge — Domain port for LLM-as-Judge evaluation.
 *
 * Hub interface: used by IGoalEvaluator, IResponseEvaluator, IOutputRailScanner,
 * IReviewerPanel, ICostAwareModelSelector, IFitnessEvaluator (6 consumers).
 *
 * @layer Domain (port contract)
 * @see Book Ch.19 "Evaluation & Testing" — Structured Rubric pattern (pp.380-395)
 * @see Book Ch.11 "Goal-Driven Agents" — dual-dimension evaluation
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Single evaluation criterion within a rubric.
 * Each criterion has a name, description, scoring scale, and optional weight.
 */
export interface EvaluationCriterion {
  readonly name: string;
  readonly description: string;
  readonly scale: { readonly min: number; readonly max: number };
  /** Weight for aggregated score calculation. Default 1.0. */
  readonly weight?: number;
}

/**
 * Structured evaluation rubric with multiple weighted criteria.
 * Book: Ch.19 — "defining rubric is the most critical step in LLM evaluation".
 */
export interface EvaluationRubric {
  readonly criteria: readonly EvaluationCriterion[];
  readonly outputFormat: 'json' | 'text';
  /** Overall score threshold for pass/fail. If omitted, no pass threshold. */
  readonly passThreshold?: number;
}

/**
 * Result of LLM-as-Judge evaluation.
 */
export interface JudgmentResult {
  /** Weighted overall score (0 to max scale). */
  readonly overallScore: number;
  /** Per-criterion scores. Key = criterion name, value = numeric score. */
  readonly criterionScores: Readonly<Record<string, number>>;
  /** Free-text rationale from the judge. */
  readonly rationale: string;
  /** Specific concerns raised by the judge. */
  readonly concerns: readonly string[];
  /** Recommended next action based on score. */
  readonly recommendedAction: 'approve' | 'revise' | 'reject';
  /** Confidence in the judgment (0-1). */
  readonly confidence: number;
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * LLM-as-Judge port — evaluates content against a structured rubric.
 *
 * Implementation calls LLM with structured output (JSON mode) and parses
 * the response into a typed {@link JudgmentResult}.
 *
 * Hub interface used by:
 *   - IGoalEvaluator (Ch.11)
 *   - IResponseEvaluator (Ch.19)
 *   - IOutputRail/OutputRailScanner (Ch.9)
 *   - IReviewerPanel (Ch.18)
 *   - ICostAwareModelSelector (Ch.16)
 *   - IFitnessEvaluator (Ch.20)
 *
 * @see DI_TOKENS.ILlmJudge
 */
export interface ILlmJudge {
  /**
   * Evaluate content against a multi-criteria rubric.
   * Produces structured judgment with per-criterion scores.
   *
   * @param content  — content to evaluate (prompt, response, code, etc.)
   * @param rubric   — evaluation rubric with weighted criteria
   * @param correlationId — request correlation ID for tracing
   * @returns Structured judgment result
   */
  judge(
    content: string,
    rubric: EvaluationRubric,
    correlationId: CorrelationId,
  ): Promise<JudgmentResult>;

  /**
   * Binary yes/no evaluation against a single criterion.
   * Optimized for guardrail checks where detailed scoring is unnecessary.
   *
   * @param content  — content to evaluate
   * @param criteria — single-sentence criterion description
   * @param correlationId — request correlation ID
   * @returns true if content passes the criterion
   */
  judgeBinary(
    content: string,
    criteria: string,
    correlationId: CorrelationId,
  ): Promise<boolean>;
}
