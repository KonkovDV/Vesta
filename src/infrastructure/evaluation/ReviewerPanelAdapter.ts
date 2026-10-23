/**
 * ReviewerPanelAdapter — Infrastructure adapter for IReviewerPanel.
 *
 * Orchestrates parallel LLM calls for each reviewer persona, then
 * aggregates individual reviews into a majority-vote consensus.
 *
 * Best Practices Applied (March 2026):
 * - AI Scientist (Sakana AI) structured review format
 * - Parallel LLM invocation via Promise.allSettled (resilient to individual failures)
 * - JSON structured output parsing with Zod-like fallback
 * - correlationId in all log entries (Hard Rule #6)
 * - temperature 0.4 for diverse but controlled review outputs
 *
 * DI: constructor(llmFactory, judge, logger) — 3 args
 *
 * @layer Infrastructure (implements Domain port)
 * @see IReviewerPanel (src/domain/evaluation/reviewer-panel.interface.ts)
 * @see Book Ch.21 "Agent Laboratory" — ReviewersAgent with multi-persona panels
 */

import type {
  IReviewerPanel,
  ReviewerPersona,
  ReviewOutput,
  PanelResult,
} from '../../domain/evaluation/reviewer-panel.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { ILlmJudge } from '../../domain/evaluation/llm-judge.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

// ── Prompt template ────────────────────────────────────────────────

function buildReviewPrompt(
  artifact: string,
  plan: string,
  persona: ReviewerPersona,
): string {
  return [
    persona.systemPrompt,
    '',
    `You are ${persona.name}, a ${persona.role} focusing on ${persona.focusArea}.`,
    '',
    '=== RESEARCH PLAN ===',
    plan,
    '',
    '=== ARTIFACT TO REVIEW ===',
    artifact,
    '',
    'Provide a structured review in JSON only (no markdown fences):',
    '{',
    '  "summary": "<2-3 sentence summary>",',
    '  "strengths": ["<strength1>", ...],',
    '  "weaknesses": ["<weakness1>", ...],',
    '  "scores": { "originality": <1-10>, "quality": <1-10>, "clarity": <1-10>, "significance": <1-10> },',
    '  "overall": <1-10>,',
    '  "decision": "accept" | "revise" | "reject",',
    '  "confidence": <1-5>',
    '}',
  ].join('\n');
}

// ── Default review output for failed reviews ───────────────────────

function createFailedReview(persona: ReviewerPersona, reason: string): ReviewOutput {
  return {
    reviewerName: persona.name,
    summary: `Review failed: ${reason}`,
    strengths: [],
    weaknesses: ['Review could not be completed'],
    scores: { originality: 0, quality: 0, clarity: 0, significance: 0 },
    overall: 0,
    decision: 'revise',
    confidence: 0,
  };
}

// ── Adapter ─────────────────────────────────────────────────────────

export class ReviewerPanelAdapter implements IReviewerPanel {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
  ) {}

  async review(
    artifact: string,
    plan: string,
    personas: readonly ReviewerPersona[],
    correlationId: CorrelationId,
  ): Promise<PanelResult> {
    this.logger.info('ReviewerPanelAdapter.review.start', {
      correlationId,
      reviewerCount: personas.length,
    });

    if (personas.length === 0) {
      this.logger.warn('ReviewerPanelAdapter.review.noPersonas', { correlationId });
      return {
        reviews: [],
        consensus: 'revise',
        averageScore: 0,
        disagreements: [],
        metaReview: 'No reviewer personas provided.',
      };
    }

    const startMs = Date.now();

    // 1. Run all reviews in parallel (resilient to individual failures)
    const { adapter: llm } = await this.llmFactory.createAdapterWithFailover();

    const reviewPromises = personas.map(async (persona): Promise<ReviewOutput> => {
      try {
        const prompt = buildReviewPrompt(artifact, plan, persona);
        const result = await llm.generateText(prompt, {
          temperature: 0.4,
          maxTokens: 2048,
        });

        return this.parseReviewOutput(persona, result.text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('ReviewerPanelAdapter.review.personaFailed', {
          correlationId,
          reviewer: persona.name,
          error: message,
        });
        return createFailedReview(persona, message);
      }
    });

    const settled = await Promise.allSettled(reviewPromises);
    const reviews = settled
      .filter((r): r is PromiseFulfilledResult<ReviewOutput> => r.status === 'fulfilled')
      .map(r => r.value);

    // 2. Aggregate results
    const validReviews = reviews.filter((r) => r.confidence > 0);
    const averageScore =
      validReviews.length > 0
        ? validReviews.reduce((sum, r) => sum + r.overall, 0) / validReviews.length
        : 0;

    // 3. Determine consensus by majority vote
    const consensus = this.computeConsensus(validReviews);

    // 4. Find disagreements
    const disagreements = this.findDisagreements(validReviews, consensus);

    const durationMs = Date.now() - startMs;

    this.logger.info('ReviewerPanelAdapter.review.complete', {
      correlationId,
      consensus,
      averageScore,
      validReviewCount: validReviews.length,
      totalReviewCount: reviews.length,
      durationMs,
    });

    return {
      reviews,
      consensus,
      averageScore,
      disagreements,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────

  private parseReviewOutput(persona: ReviewerPersona, text: string): ReviewOutput {
    try {
      const cleaned = text
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      return {
        reviewerName: persona.name,
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary',
        strengths: Array.isArray(parsed.strengths)
          ? (parsed.strengths as string[]).filter((s) => typeof s === 'string')
          : [],
        weaknesses: Array.isArray(parsed.weaknesses)
          ? (parsed.weaknesses as string[]).filter((s) => typeof s === 'string')
          : [],
        scores: typeof parsed.scores === 'object' && parsed.scores !== null
          ? parsed.scores as Record<string, number>
          : { originality: 0, quality: 0, clarity: 0, significance: 0 },
        overall: typeof parsed.overall === 'number' ? parsed.overall : 5,
        decision: this.parseDecision(parsed.decision),
        confidence: typeof parsed.confidence === 'number'
          ? Math.min(5, Math.max(1, Math.round(parsed.confidence)))
          : 3,
      };
    } catch {
      return createFailedReview(persona, 'Failed to parse LLM review output');
    }
  }

  private parseDecision(decision: unknown): 'accept' | 'revise' | 'reject' {
    if (typeof decision === 'string') {
      const lower = decision.toLowerCase();
      if (lower === 'accept') return 'accept';
      if (lower === 'reject') return 'reject';
    }
    return 'revise';
  }

  private computeConsensus(
    reviews: readonly ReviewOutput[],
  ): 'accept' | 'revise' | 'reject' {
    if (reviews.length === 0) return 'revise';

    const counts = { accept: 0, revise: 0, reject: 0 };
    for (const review of reviews) {
      counts[review.decision]++;
    }

    // Majority vote
    if (counts.accept > counts.revise && counts.accept > counts.reject) return 'accept';
    if (counts.reject > counts.accept && counts.reject > counts.revise) return 'reject';
    return 'revise';
  }

  private findDisagreements(
    reviews: readonly ReviewOutput[],
    consensus: 'accept' | 'revise' | 'reject',
  ): string[] {
    return reviews
      .filter((r) => r.decision !== consensus)
      .map((r) => `${r.reviewerName} voted "${r.decision}" (overall: ${r.overall})`);
  }
}
