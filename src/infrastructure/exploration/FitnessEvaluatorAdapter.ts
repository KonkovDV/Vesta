/**
 * FitnessEvaluatorAdapter — Infrastructure Adapter
 *
 * Evaluates candidate fitness by delegating to ILlmJudge.
 *
 * Best Practices Applied (March 2026):
 * - Multi-metric breakdown: correctness, performance, quality
 *   (OpenEvolve: metrics={"performance": x, "correctness": y})
 * - evaluationType modes: 'llm-only' supported, 'sandbox'/'hybrid' → require
 *   ISandboxedExecutor (not yet injected — throws EvaluationFailedError)
 * - Batch evaluation via Promise.allSettled for resilient parallel processing
 *   (Dria Research: serial degrades 47-50%, parallel essential)
 *   FIX-R01: Promise.allSettled prevents single failure from crashing batch
 * - Fitness normalized to 0–1 range (OpenEvolve convention)
 *
 * DI: constructor(judge: ILlmJudge, logger: IStructuredLogger) — 2 args
 */
import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ILlmJudge } from '../../domain/evaluation/llm-judge.interface';
import type { Candidate } from '../../domain/exploration/evolution-engine.interface';
import type { IFitnessEvaluator, FitnessResult } from '../../domain/exploration/fitness-evaluator.interface';
import { EvaluationFailedError } from '../../domain/errors/agentic-errors';

export class FitnessEvaluatorAdapter implements IFitnessEvaluator {
  constructor(
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
  ) {}

  async evaluate(
    candidate: Candidate,
    objective: string,
    correlationId: CorrelationId,
    evaluationType: 'llm-only' | 'sandbox' | 'hybrid' = 'llm-only',
  ): Promise<FitnessResult> {
    this.logger.info('FitnessEvaluatorAdapter.evaluate', {
      correlationId,
      candidateId: candidate.id,
      evaluationType,
    });

    if (evaluationType === 'sandbox' || evaluationType === 'hybrid') {
      throw new EvaluationFailedError(
        `evaluationType '${evaluationType}' requires ISandboxedExecutor (not available)`,
        correlationId,
      );
    }

    return this.evaluateViaLlm(candidate, objective, correlationId);
  }

  async evaluateBatch(
    candidates: readonly Candidate[],
    objective: string,
    correlationId: CorrelationId,
  ): Promise<readonly FitnessResult[]> {
    this.logger.info('FitnessEvaluatorAdapter.evaluateBatch', {
      correlationId,
      candidateCount: candidates.length,
    });

    // Parallel batch evaluation (Dria best practice: parallel is essential)
    // FIX-R01: Promise.allSettled — one failed evaluation must not crash entire batch
    const settled = await Promise.allSettled(
      candidates.map((c) => this.evaluate(c, objective, correlationId)),
    );

    const results: FitnessResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        this.logger.warn('FitnessEvaluatorAdapter.evaluateBatch.candidateFailed', {
          correlationId,
          candidateId: candidates[i].id,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        // Assign zero fitness to failed candidates instead of crashing batch
        results.push({
          candidateId: candidates[i].id,
          fitness: 0,
          breakdown: {},
          feedback: `Evaluation failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        });
      }
    }

    return results;
  }

  /** Evaluate via ILlmJudge using multi-metric rubric */
  private async evaluateViaLlm(
    candidate: Candidate,
    objective: string,
    correlationId: CorrelationId,
  ): Promise<FitnessResult> {
    try {
      const rubric = {
        criteria: [
          {
            name: 'correctness',
            description: 'Does the code correctly implement the objective?',
            scale: { min: 0, max: 10 },
            weight: 2.0,
          },
          {
            name: 'performance',
            description: 'Is the code efficient in time and space complexity?',
            scale: { min: 0, max: 10 },
            weight: 1.5,
          },
          {
            name: 'quality',
            description: 'Code readability, maintainability, and best practices',
            scale: { min: 0, max: 10 },
            weight: 0.5,
          },
        ],
        outputFormat: 'json' as const,
        passThreshold: 5.0,
      };

      const content = `Objective: ${objective}\n\nCandidate Code (gen ${candidate.generation}):\n${candidate.code}`;
      const result = await this.judge.judge(content, rubric, correlationId);

      // Normalize to 0–1 range (OpenEvolve convention)
      const fitness = Math.min(1, Math.max(0, result.overallScore / 10));

      const breakdown: Record<string, number> = {};
      for (const [name, score] of Object.entries(result.criterionScores)) {
        breakdown[name] = score / 10; // normalize each to 0-1
      }

      return {
        candidateId: candidate.id,
        fitness,
        breakdown,
        feedback: result.rationale,
      };
    } catch (error) {
      if (error instanceof EvaluationFailedError) throw error;
      throw new EvaluationFailedError(
        `Fitness evaluation failed for candidate ${candidate.id}: ${(error as Error).message}`,
        correlationId,
      );
    }
  }
}
