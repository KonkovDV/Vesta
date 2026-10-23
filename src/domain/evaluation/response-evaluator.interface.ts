/**
 * IResponseEvaluator — Domain port for dual-dimension response evaluation.
 *
 * Evaluates responses on two orthogonal dimensions: accuracy + helpfulness.
 * Produces a recommendation (accept / improve / reject) for downstream use.
 *
 * @layer Domain (depends only on Core)
 * @see Book Ch.19 "Evaluation & Testing" — Dual-Dimension Evaluation
 * @see ILlmJudge (src/domain/evaluation/llm-judge.interface.ts)
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Value Objects ────────────────────────────────────────────────────

/**
 * Boundary discipline metrics for evidence-bounded responses.
 */
export interface ResponseBoundaryMetrics {
  /** Claim-like sentences detected in response text. */
  readonly totalClaimSentences: number;
  /** Claim-like sentences without evidence markers. */
  readonly unsupportedClaimCount: number;
  /** Ratio in range [0,1]; 1 means all claims are evidence-bounded. */
  readonly evidenceBoundedRatio: number;
  /** Human-readable boundary violation snippets (capped). */
  readonly unsupportedClaimSnippets: readonly string[];
}

/**
 * Dual-dimension evaluation result.
 */
export interface DualDimensionResult {
  /** Accuracy score (0-10): factual correctness, precision */
  readonly accuracy: number;
  /** Helpfulness score (0-10): relevance, completeness, actionability */
  readonly helpfulness: number;
  /** Weighted overall score (0-10) */
  readonly overallScore: number;
  /** Per-dimension textual feedback */
  readonly dimensionFeedback: {
    readonly accuracy: string;
    readonly helpfulness: string;
  };
  /** Boundary discipline metrics derived from generated response text. */
  readonly boundaryMetrics: ResponseBoundaryMetrics;
  /** Final recommendation based on score thresholds */
  readonly recommendation: 'accept' | 'improve' | 'reject';
}

// ── Port Interface ──────────────────────────────────────────────────

/**
 * Evaluates responses on dual dimensions: accuracy + helpfulness.
 * Delegates to ILlmJudge with prebuilt dual-dimension rubric.
 *
 * @see Book Ch.19 "Evaluation & Testing" — Dual-Dimension pattern
 */
export interface IResponseEvaluator {
  /**
   * Evaluate a response against the original prompt.
   *
   * @param prompt — the original user prompt
   * @param response — the LLM-generated response to evaluate
   * @param correlationId — request correlation ID for tracing
   * @returns Dual-dimension result with accuracy, helpfulness, and recommendation
   */
  evaluate(
    prompt: string,
    response: string,
    correlationId: CorrelationId,
  ): Promise<DualDimensionResult>;
}
