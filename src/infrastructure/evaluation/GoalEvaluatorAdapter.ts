/**
 * GoalEvaluatorAdapter — Infrastructure adapter for IGoalEvaluator.
 *
 * Delegates to ILlmJudge with a goal-specific rubric. Converts
 * GoalDefinition → EvaluationRubric, then maps JudgmentResult → GoalEvaluationResult.
 *
 * @layer Infrastructure (implements Domain port)
 * @see IGoalEvaluator (src/domain/evaluation/goal-evaluator.interface.ts)
 * @see Book Ch.11 "Goal-Driven Agents" — Goal Verification
 */

import type {
  IGoalEvaluator,
  GoalDefinition,
  GoalEvaluationResult,
} from '../../domain/evaluation/goal-evaluator.interface';
import type { ILlmJudge, EvaluationRubric } from '../../domain/evaluation/llm-judge.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';
import { EvaluationFailedError } from '../../domain/errors/agentic-errors';

// ── Private helpers ─────────────────────────────────────────────────

/**
 * Convert GoalDefinition → EvaluationRubric for ILlmJudge.
 */
function buildGoalRubric(goal: GoalDefinition): EvaluationRubric {
  const criteria = goal.successCriteria.map((criterion, idx) => ({
    name: `criterion_${idx + 1}`,
    description: criterion,
    scale: { min: 0, max: 10 },
    weight: 1.0,
  }));

  if (goal.constraints?.length) {
    goal.constraints.forEach((constraint, idx) => {
      criteria.push({
        name: `constraint_${idx + 1}`,
        description: `Constraint: ${constraint}`,
        scale: { min: 0, max: 10 },
        weight: 0.8,
      });
    });
  }

  return {
    criteria,
    outputFormat: 'json',
    passThreshold: 7.0,
  };
}

// ── Adapter ─────────────────────────────────────────────────────────

export class GoalEvaluatorAdapter implements IGoalEvaluator {
  constructor(
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
  ) {}

  async evaluate(
    output: string,
    goal: GoalDefinition,
    correlationId: CorrelationId,
  ): Promise<GoalEvaluationResult> {
    this.logger.info('GoalEvaluator: evaluating output against goal', {
      correlationId,
      goal: goal.goal,
      criteriaCount: goal.successCriteria.length,
    });

    try {
      const rubric = buildGoalRubric(goal);
      const judgment = await this.judge.judge(
        `Goal: ${goal.goal}\n\nOutput to evaluate:\n${output}`,
        rubric,
        correlationId,
      );

      // Map criterion scores to boolean pass/fail (S2-10 fix: index-based mapping)
      // buildGoalRubric names criteria as criterion_1, criterion_2, ... so we map by index
      const criteriaResults: Record<string, boolean> = {};
      for (let idx = 0; idx < goal.successCriteria.length; idx++) {
        const criterion = goal.successCriteria[idx];
        const key = `criterion_${idx + 1}`;
        criteriaResults[criterion] = (judgment.criterionScores[key] ?? 0) >= (rubric.passThreshold ?? 7.0);
      }

      const goalMet = judgment.overallScore >= (rubric.passThreshold ?? 7.0);

      // Extract improvement suggestions from concerns
      const suggestedImprovements = judgment.concerns.length > 0
        ? judgment.concerns
        : goalMet ? [] : ['Consider addressing the evaluation rationale feedback'];

      const result: GoalEvaluationResult = {
        goalMet,
        criteriaResults,
        overallScore: judgment.overallScore,
        feedback: judgment.rationale,
        suggestedImprovements,
      };

      this.logger.info('GoalEvaluator: evaluation complete', {
        correlationId,
        goalMet,
        overallScore: judgment.overallScore,
      });

      return result;
    } catch (error) {
      if (error instanceof EvaluationFailedError) {
        throw error;
      }
      throw new EvaluationFailedError(
        `Goal evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        correlationId,
      );
    }
  }
}
