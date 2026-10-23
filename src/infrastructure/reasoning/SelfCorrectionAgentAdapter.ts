/**
 * SelfCorrectionAgentAdapter — Infrastructure adapter for ISelfCorrectionAgent.
 *
 * Implements the Generate → Evaluate → Correct loop.
 * Uses ILlmJudge for binary/rubric evaluation and LLM for corrective generation.
 * Emits per-attempt and completion events via IEventStore.
 *
 * @layer Infrastructure (implements Domain port)
 * @see ISelfCorrectionAgent (src/domain/reasoning/self-correction.interface.ts)
 * @see Book Ch.17 "Reasoning" — self-correction agent (pp.345-355)
 */

import type {
  ISelfCorrectionAgent,
  SelfCorrectionConfig,
  SelfCorrectionResult,
  CorrectionAttempt,
} from '../../domain/reasoning/self-correction.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { IReflectionLoop } from '../../domain/reasoning/reflection-loop.interface';
import type { ILlmJudge, EvaluationRubric } from '../../domain/evaluation/llm-judge.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { CorrelationId } from '../../core/types/branded';
import { SelfCorrectionError } from '../../domain/errors/agentic-errors';

// ── Adapter ─────────────────────────────────────────────────────────

export class SelfCorrectionAgentAdapter implements ISelfCorrectionAgent {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly reflectionLoop: IReflectionLoop,
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
    private readonly eventStore: IEventStore,
  ) {}

  async correct(
    task: string,
    config: SelfCorrectionConfig,
    correlationId: CorrelationId,
  ): Promise<SelfCorrectionResult> {
    const attempts: CorrectionAttempt[] = [];
    let bestAttempt: CorrectionAttempt | undefined;

    this.logger.info('SelfCorrectionAgent starting', {
      correlationId,
      maxAttempts: config.maxAttempts,
      threshold: config.acceptThreshold,
    });

    try {
      for (let i = 1; i <= config.maxAttempts; i++) {
        // Generate content (first attempt: direct LLM; subsequent: use reflection with feedback)
        let content: string;

        if (i === 1) {
          content = await this.generateInitial(task, config, correlationId);
        } else {
          // Use reflection loop to improve based on previous feedback
          // FIX-S2-08: Pass actual content + feedback (not just feedback as content)
          const prevContent = attempts[attempts.length - 1]?.content ?? '';
          const prevFeedback = attempts[attempts.length - 1]?.feedback ?? '';
          content = await this.generateCorrected(
            task, prevContent, prevFeedback, config, correlationId,
          );
        }

        // Evaluate with ILlmJudge
        const evaluation = await this.evaluate(content, config, correlationId);

        const accepted = evaluation.score >= config.acceptThreshold;
        const attempt: CorrectionAttempt = {
          attemptNumber: i,
          content,
          score: evaluation.score,
          accepted,
          feedback: evaluation.feedback,
        };
        attempts.push(attempt);

        // Track best attempt
        if (!bestAttempt || evaluation.score > bestAttempt.score) {
          bestAttempt = attempt;
        }

        // Emit per-attempt event
        await this.emitAttemptEvent(attempt, config.maxAttempts, correlationId);

        this.logger.info('SelfCorrectionAgent attempt completed', {
          correlationId,
          attempt: i,
          score: evaluation.score,
          accepted,
        });

        if (accepted) break;
      }

      const result: SelfCorrectionResult = {
        finalContent: bestAttempt!.content,
        finalScore: bestAttempt!.score,
        accepted: bestAttempt!.accepted,
        attempts,
        totalAttempts: attempts.length,
      };

      // Emit completion event
      await this.emitCompletionEvent(result, correlationId);

      this.logger.info('SelfCorrectionAgent completed', {
        correlationId,
        totalAttempts: result.totalAttempts,
        finalScore: result.finalScore,
        accepted: result.accepted,
      });

      return result;
    } catch (error) {
      this.logger.error('SelfCorrectionAgent failed', {
        correlationId,
        attemptsCompleted: attempts.length,
        error: error instanceof Error ? error.message : String(error),
      });

      // If we have any successful attempts, return the best one
      if (bestAttempt) {
        return {
          finalContent: bestAttempt.content,
          finalScore: bestAttempt.score,
          accepted: false,
          attempts,
          totalAttempts: attempts.length,
        };
      }

      // bestAttempt is guaranteed undefined here (truthiness guard above returned)
      throw new SelfCorrectionError(
        `Self-correction failed: ${error instanceof Error ? error.message : String(error)}`,
        attempts.length,
        0,
        correlationId,
      );
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async generateInitial(
    task: string,
    config: SelfCorrectionConfig,
    correlationId: CorrelationId,
  ): Promise<string> {
    const { adapter } = await this.llmFactory.createAdapterWithFailover();
    const result = await adapter.generateText(task, {
      maxTokens: 4096,
      temperature: 0.7,
      timeoutMs: config.timeoutMs,
    });
    return result.text.trim();
  }

  private async generateCorrected(
    task: string,
    previousContent: string,
    feedback: string,
    config: SelfCorrectionConfig,
    correlationId: CorrelationId,
  ): Promise<string> {
    // FIX-S2-08: Enrich task with feedback, pass actual content as initialContent
    const enrichedTask = `${task}\n\nFeedback on previous attempt:\n${feedback}\n\nImprove the content based on this feedback.`;
    const reflectionResult = await this.reflectionLoop.execute(
      enrichedTask,
      previousContent,
      {
        maxIterations: 1,
        stateless: true,
      },
      correlationId,
    );
    return reflectionResult.finalContent;
  }

  private async evaluate(
    content: string,
    config: SelfCorrectionConfig,
    correlationId: CorrelationId,
  ): Promise<{ score: number; feedback: string }> {
    const rubric: EvaluationRubric = {
      criteria: [
        {
          name: 'quality',
          description: config.evaluationCriteria,
          scale: { min: 0, max: 10 },
          weight: 1.0,
        },
      ],
      outputFormat: 'json',
    };

    const judgment = await this.judge.judge(content, rubric, correlationId);

    return {
      score: judgment.overallScore,
      feedback: judgment.rationale + (judgment.concerns.length > 0
        ? '\nConcerns: ' + judgment.concerns.join('; ')
        : ''),
    };
  }

  private async emitAttemptEvent(
    attempt: CorrectionAttempt,
    maxAttempts: number,
    correlationId: CorrelationId,
  ): Promise<void> {
    const event = EventFactory.createBaseEvent(
      'self-correction',
      'agentic.selfcorrection.attempt',
      {
        attemptNumber: attempt.attemptNumber,
        maxAttempts,
        score: attempt.score,
        accepted: attempt.accepted,
      },
      correlationId,
    );
    await this.eventStore.saveEvents([event]);
  }

  private async emitCompletionEvent(
    result: SelfCorrectionResult,
    correlationId: CorrelationId,
  ): Promise<void> {
    const event = EventFactory.createBaseEvent(
      'self-correction',
      'agentic.selfcorrection.completed',
      {
        totalAttempts: result.totalAttempts,
        finalScore: result.finalScore,
        accepted: result.accepted,
      },
      correlationId,
    );
    await this.eventStore.saveEvents([event]);
  }
}
