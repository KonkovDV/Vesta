/**
 * Fitness Evaluator — Domain Interface (Port)
 *
 * Evaluates candidate fitness — delegates to ILlmJudge or test execution.
 *
 * Best Practices Applied (March 2026):
 * - Multi-metric breakdown (OpenEvolve: correctness, performance, quality)
 * - evaluationType modes: 'llm-only' | 'sandbox' | 'hybrid'
 * - Batch evaluation for population scoring with parallel processing
 *   (Dria Research: serial evaluation degrades by 47-50%)
 * - Fitness normalized to 0–1 range (OpenEvolve convention)
 *
 * @see Book Ch.9 "Autonomous Code Generation" — Fitness-Driven Selection
 * @see OpenEvolve EvaluationResult metrics={"performance": x, "correctness": y}
 * @see Gulli, "Agentic Design Patterns" (Springer 2026)
 */
import type { CorrelationId } from '@/core/types/branded';
import type { Candidate } from './evolution-engine.interface';

export interface FitnessResult {
  readonly candidateId: string;
  readonly fitness: number;              // 0–1 normalized
  readonly breakdown: Readonly<Record<string, number>>;
  readonly feedback: string;
}

export interface IFitnessEvaluator {
  evaluate(
    candidate: Candidate,
    objective: string,
    correlationId: CorrelationId,
    evaluationType?: 'llm-only' | 'sandbox' | 'hybrid',
  ): Promise<FitnessResult>;

  evaluateBatch(
    candidates: readonly Candidate[],
    objective: string,
    correlationId: CorrelationId,
  ): Promise<readonly FitnessResult[]>;
}
