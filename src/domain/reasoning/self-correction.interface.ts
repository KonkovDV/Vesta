/**
 * ISelfCorrectionAgent — Domain port for self-correcting generation.
 *
 * Pattern: Generate → Evaluate → if score < threshold → Reflect → Regenerate → loop.
 * Uses ILlmJudge for evaluation and IReflectionLoop for correction.
 *
 * @layer Domain (port contract)
 * @see Book Ch.17 "Reasoning" — self-correction agent (pp.345-355)
 * @see Book Ch.4 "Reflection" — reflection-based correction (pp.75-92)
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Configuration for self-correction execution.
 */
export interface SelfCorrectionConfig {
  /** Maximum correction attempts before accepting best result. Default: 3. */
  readonly maxAttempts: number;
  /** Score threshold (0-10) to accept output without correction. Default: 7. */
  readonly acceptThreshold: number;
  /**
   * Evaluation criteria for the judge to assess generated output.
   * E.g., "correctness", "completeness", "code quality".
   */
  readonly evaluationCriteria: string;
  /** Model to use for generation. If omitted, uses default. */
  readonly model?: string;
  /** Per-attempt timeout in ms. */
  readonly timeoutMs?: number;
}

/**
 * Record of a single correction attempt.
 */
export interface CorrectionAttempt {
  /** 1-based attempt number. */
  readonly attemptNumber: number;
  /** Content generated in this attempt. */
  readonly content: string;
  /** Score given by the judge (0-10). */
  readonly score: number;
  /** Whether this attempt was accepted (score >= threshold). */
  readonly accepted: boolean;
  /** Feedback from evaluation (used to guide next attempt). */
  readonly feedback: string;
}

/**
 * Final result of the self-correction process.
 */
export interface SelfCorrectionResult {
  /** Best content produced across all attempts. */
  readonly finalContent: string;
  /** Score of the accepted/best attempt. */
  readonly finalScore: number;
  /** Whether any attempt met the acceptance threshold. */
  readonly accepted: boolean;
  /** All correction attempts for audit trail. */
  readonly attempts: readonly CorrectionAttempt[];
  /** Total number of attempts executed. */
  readonly totalAttempts: number;
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * Self-Correcting Generation Agent.
 *
 * Book Ch.17: "Self-correction combines generation with evaluation in a tight
 * feedback loop, using each evaluation to guide the next generation attempt."
 *
 * Depends on:
 *   - ILLMAdapterFactory — generation calls
 *   - IReflectionLoop — generates refined content based on feedback
 *   - ILlmJudge — evaluates each attempt against criteria
 *
 * @see DI_TOKENS.ISelfCorrectionAgent
 */
export interface ISelfCorrectionAgent {
  /**
   * Generate content with iterative self-correction.
   *
   * Flow:
   * 1. Generate initial output for the task
   * 2. Evaluate with ILlmJudge against criteria
   * 3. If score >= threshold → accept and return
   * 4. Otherwise → use evaluation feedback to generate improved version
   * 5. Repeat until accepted or maxAttempts reached
   * 6. Return best attempt (highest score) if none accepted
   *
   * @param task — what to generate (instruction/prompt)
   * @param config — correction configuration
   * @param correlationId — request correlation ID for tracing
   * @returns Self-correction result with all attempts
   */
  correct(
    task: string,
    config: SelfCorrectionConfig,
    correlationId: CorrelationId,
  ): Promise<SelfCorrectionResult>;
}
