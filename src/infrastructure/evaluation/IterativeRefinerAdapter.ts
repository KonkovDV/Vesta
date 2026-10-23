/**
 * IterativeRefinerAdapter — Infrastructure adapter for IIterativeRefiner.
 *
 * Combines IGoalEvaluator + IReflectionLoop to iteratively improve
 * output until it meets the goal's success criteria.
 *
 * @layer Infrastructure (implements Domain port)
 * @see IIterativeRefiner (src/domain/evaluation/iterative-refiner.interface.ts)
 * @see Book Ch.11 "Goal-Driven Agents" — Goal-Driven Iterative Refinement
 */

import type {
  IIterativeRefiner,
  RefinerConfig,
  RefinementResult,
} from '../../domain/evaluation/iterative-refiner.interface';
import type {
  GoalDefinition,
  GoalEvaluationResult,
} from '../../domain/evaluation/goal-evaluator.interface';
import type { IGoalEvaluator } from '../../domain/evaluation/goal-evaluator.interface';
import type { IReflectionLoop } from '../../domain/reasoning/reflection-loop.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';
import { MaxIterationsExceededError } from '../../domain/errors/agentic-errors';

// ── Adapter ─────────────────────────────────────────────────────────

export class IterativeRefinerAdapter implements IIterativeRefiner {
  constructor(
    private readonly reflectionLoop: IReflectionLoop,
    private readonly goalEvaluator: IGoalEvaluator,
    private readonly logger: ILogger,
  ) {}

  async refine(
    initialOutput: string,
    goal: GoalDefinition,
    config: RefinerConfig,
    correlationId: CorrelationId,
  ): Promise<RefinementResult> {
    this.logger.info('IterativeRefiner: starting refinement', {
      correlationId,
      goal: goal.goal,
      maxIterations: config.maxIterations,
    });

    let currentOutput = initialOutput;
    const evaluations: GoalEvaluationResult[] = [];
    let previousScore = -1;

    for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
      // Evaluate current output against goal
      const evaluation = await this.goalEvaluator.evaluate(currentOutput, goal, correlationId);
      evaluations.push(evaluation);

      this.logger.info('IterativeRefiner: iteration evaluated', {
        correlationId,
        iteration,
        overallScore: evaluation.overallScore,
        goalMet: evaluation.goalMet,
      });

      // Goal met — converged
      if (evaluation.goalMet) {
        this.logger.info('IterativeRefiner: goal met — converged', {
          correlationId,
          iterations: iteration,
          finalScore: evaluation.overallScore,
        });

        return {
          finalOutput: currentOutput,
          iterations: iteration,
          initialScore: evaluations[0].overallScore,
          finalScore: evaluation.overallScore,
          evaluations,
          converged: true,
        };
      }

      // Check for stagnation (insufficient improvement)
      if (
        previousScore >= 0 &&
        evaluation.overallScore - previousScore < config.improvementThreshold
      ) {
        this.logger.info('IterativeRefiner: stagnation detected — stopping', {
          correlationId,
          iteration,
          previousScore,
          currentScore: evaluation.overallScore,
          threshold: config.improvementThreshold,
        });

        return {
          finalOutput: currentOutput,
          iterations: iteration,
          initialScore: evaluations[0].overallScore,
          finalScore: evaluation.overallScore,
          evaluations,
          converged: false,
        };
      }

      previousScore = evaluation.overallScore;

      // Improve output using reflection loop or direct approach
      if (config.useReflectionLoop) {
        const feedbackTask = [
          `Improve the following output to better meet the goal.`,
          ``,
          `Goal: ${goal.goal}`,
          ``,
          `Feedback: ${evaluation.feedback}`,
          ``,
          `Suggested improvements:`,
          ...evaluation.suggestedImprovements.map((s) => `- ${s}`),
        ].join('\n');

        const reflectResult = await this.reflectionLoop.execute(
          feedbackTask,
          currentOutput,
          { maxIterations: 1, stateless: true },
          correlationId,
        );

        currentOutput = reflectResult.finalContent;
      }
      // If useReflectionLoop=false, the caller is expected to provide
      // external improvement; we just return stagnation/max-iterations
    }

    // Max iterations reached without convergence
    this.logger.warn('IterativeRefiner: max iterations reached', {
      correlationId,
      maxIterations: config.maxIterations,
      finalScore: evaluations[evaluations.length - 1]?.overallScore ?? 0,
    });

    const finalEval = evaluations[evaluations.length - 1];

    return {
      finalOutput: currentOutput,
      iterations: config.maxIterations,
      initialScore: evaluations[0].overallScore,
      finalScore: finalEval?.overallScore ?? 0,
      evaluations,
      converged: false,
    };
  }
}
