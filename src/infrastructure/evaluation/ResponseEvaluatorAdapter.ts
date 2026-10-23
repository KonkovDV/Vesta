/**
 * ResponseEvaluatorAdapter — Infrastructure adapter for IResponseEvaluator.
 *
 * Evaluates responses on dual dimensions: accuracy + helpfulness.
 * Delegates to ILlmJudge with a prebuilt dual-dimension rubric.
 *
 * @layer Infrastructure (implements Domain port)
 * @see IResponseEvaluator (src/domain/evaluation/response-evaluator.interface.ts)
 * @see Book Ch.19 "Evaluation & Testing" — Dual-Dimension Evaluation
 */

import type {
  IResponseEvaluator,
  DualDimensionResult,
  ResponseBoundaryMetrics,
} from '../../domain/evaluation/response-evaluator.interface';
import type { ILlmJudge, EvaluationRubric } from '../../domain/evaluation/llm-judge.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';
import { EvaluationFailedError } from '../../domain/errors/agentic-errors';

// ── Private helpers ─────────────────────────────────────────────────

/** Standard dual-dimension rubric: accuracy + helpfulness */
function buildDualDimensionRubric(): EvaluationRubric {
  return {
    criteria: [
      {
        name: 'accuracy',
        description: 'Factual correctness, precision, absence of hallucination',
        scale: { min: 0, max: 10 },
        weight: 1.5,
      },
      {
        name: 'helpfulness',
        description: 'Relevance to prompt, completeness, actionability, clarity',
        scale: { min: 0, max: 10 },
        weight: 1.0,
      },
    ],
    outputFormat: 'json',
    passThreshold: 7.0,
  };
}

function deriveRecommendation(overallScore: number): 'accept' | 'improve' | 'reject' {
  if (overallScore >= 7.0) return 'accept';
  if (overallScore >= 4.0) return 'improve';
  return 'reject';
}

const STRONG_ASSERTION_PATTERN =
  /\b(always|never|guarantee(?:d|s)?|proven?|definitely|certainly|eliminate(?:d|s)?|no\s+risk|cannot\s+fail|100%)\b/i;
const EVIDENCE_MARKER_PATTERN =
  /(\[evidence:|\[source:|https?:\/\/|`[^`]+\.(md|ts|tsx|js|py|json|yml|yaml)(#[^`]+)?`)/i;
const MAX_SNIPPET_LENGTH = 160;
const MAX_SNIPPETS = 5;

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function truncateSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_SNIPPET_LENGTH)}...`;
}

function deriveBoundaryMetrics(response: string): ResponseBoundaryMetrics {
  const sentences = splitIntoSentences(response);
  const claimSentences = sentences.filter((sentence) =>
    STRONG_ASSERTION_PATTERN.test(sentence),
  );

  if (claimSentences.length === 0) {
    return {
      totalClaimSentences: 0,
      unsupportedClaimCount: 0,
      evidenceBoundedRatio: 1,
      unsupportedClaimSnippets: [],
    };
  }

  const unsupportedClaimSentences = claimSentences.filter(
    (sentence) => !EVIDENCE_MARKER_PATTERN.test(sentence),
  );

  const supportedClaims = claimSentences.length - unsupportedClaimSentences.length;
  const evidenceBoundedRatio = Number(
    (supportedClaims / claimSentences.length).toFixed(3),
  );

  return {
    totalClaimSentences: claimSentences.length,
    unsupportedClaimCount: unsupportedClaimSentences.length,
    evidenceBoundedRatio,
    unsupportedClaimSnippets: unsupportedClaimSentences
      .slice(0, MAX_SNIPPETS)
      .map(truncateSnippet),
  };
}

// ── Adapter ─────────────────────────────────────────────────────────

export class ResponseEvaluatorAdapter implements IResponseEvaluator {
  constructor(
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
  ) {}

  async evaluate(
    prompt: string,
    response: string,
    correlationId: CorrelationId,
  ): Promise<DualDimensionResult> {
    this.logger.info('ResponseEvaluator: evaluating response', { correlationId });

    try {
      const rubric = buildDualDimensionRubric();
      const content = [
        '=== ORIGINAL PROMPT ===',
        prompt,
        '',
        '=== RESPONSE TO EVALUATE ===',
        response,
      ].join('\n');

      const judgment = await this.judge.judge(content, rubric, correlationId);

      const accuracy = judgment.criterionScores['accuracy'] ?? judgment.overallScore;
      const helpfulness = judgment.criterionScores['helpfulness'] ?? judgment.overallScore;
      const overallScore = judgment.overallScore;
      const boundaryMetrics = deriveBoundaryMetrics(response);

      let recommendation = deriveRecommendation(overallScore);
      if (boundaryMetrics.unsupportedClaimCount > 0) {
        recommendation = 'reject';
      }

      const result: DualDimensionResult = {
        accuracy,
        helpfulness,
        overallScore,
        dimensionFeedback: {
          accuracy: judgment.concerns.find((c) => c.toLowerCase().includes('accura'))
            ?? (accuracy >= 7.0 ? 'Accurate and factually correct' : 'Accuracy needs improvement'),
          helpfulness: judgment.concerns.find((c) => c.toLowerCase().includes('help'))
            ?? (helpfulness >= 7.0 ? 'Helpful and complete' : 'Helpfulness needs improvement'),
        },
        boundaryMetrics,
        recommendation,
      };

      this.logger.info('ResponseEvaluator: evaluation complete', {
        correlationId,
        accuracy,
        helpfulness,
        unsupportedClaimCount: boundaryMetrics.unsupportedClaimCount,
        evidenceBoundedRatio: boundaryMetrics.evidenceBoundedRatio,
        recommendation: result.recommendation,
      });

      return result;
    } catch (error) {
      if (error instanceof EvaluationFailedError) {
        throw error;
      }
      throw new EvaluationFailedError(
        `Response evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        correlationId,
      );
    }
  }
}
