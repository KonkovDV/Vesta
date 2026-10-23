/**
 * IReviewerPanel — Domain port for multi-persona review panel.
 *
 * Orchestrates multiple LLM reviewer personas for parallel evaluation.
 * Each reviewer evaluates independently, then results aggregate to consensus.
 * Follows AI Scientist (Sakana AI) structured review format.
 *
 * @layer Domain (port contract)
 * @see Book Ch.21 "Agent Laboratory" — ReviewersAgent
 * @see ILlmJudge (src/domain/evaluation/llm-judge.interface.ts) — base evaluation
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Reviewer persona definition — determines evaluation style and focus.
 */
export interface ReviewerPersona {
  readonly name: string;
  readonly role: string;            // e.g., "Domain Expert", "Methodology Reviewer"
  readonly systemPrompt: string;    // Full system prompt that defines the persona
  readonly focusArea: string;       // Primary concern (e.g., "technical rigor", "novelty")
}

/**
 * Individual review output from a single reviewer persona.
 */
export interface ReviewOutput {
  readonly reviewerName: string;
  readonly summary: string;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly scores: Readonly<Record<string, number>>; // originality, quality, clarity, significance
  readonly overall: number;            // 1-10
  readonly decision: 'accept' | 'revise' | 'reject';
  readonly confidence: number;         // 1-5
}

/**
 * Aggregated panel result with consensus from all reviewers.
 */
export interface PanelResult {
  readonly reviews: readonly ReviewOutput[];
  readonly consensus: 'accept' | 'revise' | 'reject';
  readonly averageScore: number;
  readonly disagreements: readonly string[];
  readonly metaReview?: string;
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * Multi-persona review panel — parallel LLM calls with different reviewer personas.
 * Aggregates individual reviews into consensus decision.
 *
 * @see DI_TOKENS.IReviewerPanel
 */
export interface IReviewerPanel {
  /**
   * Review an artifact using multiple reviewer personas.
   *
   * @param artifact      — content to review (paper, code, plan, etc.)
   * @param plan          — research plan or context for the review
   * @param personas      — array of reviewer personas (min 2 recommended)
   * @param correlationId — request correlation ID for tracing
   * @returns Aggregated panel result with per-reviewer reviews and consensus
   */
  review(
    artifact: string,
    plan: string,
    personas: readonly ReviewerPersona[],
    correlationId: CorrelationId,
  ): Promise<PanelResult>;
}
