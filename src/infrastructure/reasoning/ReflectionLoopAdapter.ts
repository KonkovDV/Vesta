/**
 * ReflectionLoopAdapter — Infrastructure adapter for IReflectionLoop.
 *
 * Implements the Generate→Reflect→Refine loop pattern from Ch.4.
 * Directly invokes LLM for generate and reflect cycles.
 * Supports stateless mode (fresh context each iteration) and sentinel token stop.
 *
 * @layer Infrastructure (implements Domain port)
 * @see IReflectionLoop (src/domain/reasoning/reflection-loop.interface.ts)
 * @see Book Ch.4 "Reflection" — iterative generate→reflect→refine (pp.75-92)
 */

import type {
  IReflectionLoop,
  ReflectionConfig,
  ReflectionResult,
  ReflectionIteration,
} from '../../domain/reasoning/reflection-loop.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { ILlmJudge } from '../../domain/evaluation/llm-judge.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { CorrelationId } from '../../core/types/branded';
import { ReasoningTimeoutError } from '../../domain/errors/agentic-errors';

// ── Prompt templates ────────────────────────────────────────────────

function buildGeneratePrompt(task: string, currentContent: string): string {
  if (!currentContent) {
    return [
      'You are an expert assistant. Perform the following task:',
      '',
      task,
      '',
      'Provide your best output.',
    ].join('\n');
  }

  return [
    'You are an expert assistant. Improve the following content based on the original task.',
    '',
    '=== ORIGINAL TASK ===',
    task,
    '',
    '=== CURRENT CONTENT ===',
    currentContent,
    '',
    'Provide an improved version of the content.',
  ].join('\n');
}

function buildReflectPrompt(task: string, content: string, sentinelToken?: string): string {
  const parts = [
    'You are a critical reviewer. Reflect on the following content with respect to the task.',
    '',
    '=== TASK ===',
    task,
    '',
    '=== CONTENT TO REVIEW ===',
    content,
    '',
    'Provide specific, actionable feedback.',
    'If the content is excellent and needs no changes, state that clearly.',
  ];

  if (sentinelToken) {
    parts.push(
      '',
      `If the content is perfect and needs absolutely no changes, include the exact token "${sentinelToken}" in your response.`,
    );
  }

  return parts.join('\n');
}

// ── Adapter ─────────────────────────────────────────────────────────

export class ReflectionLoopAdapter implements IReflectionLoop {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly logger: ILogger,
    private readonly eventStore: IEventStore,
    private readonly judge: ILlmJudge,
  ) {}

  async execute(
    task: string,
    initialContent: string,
    config: ReflectionConfig,
    correlationId: CorrelationId,
  ): Promise<ReflectionResult> {
    const iterations: ReflectionIteration[] = [];
    let currentContent = initialContent;
    let stoppedBy: ReflectionResult['stoppedBy'] = 'max_iterations';

    this.logger.info('ReflectionLoop starting', {
      correlationId,
      maxIterations: config.maxIterations,
      stateless: config.stateless,
      hasSentinel: !!config.sentinelToken,
    });

    for (let i = 1; i <= config.maxIterations; i++) {
      try {
        // Generate phase
        const { adapter: genAdapter } = await this.llmFactory.createAdapterWithFailover();
        const generatePrompt = buildGeneratePrompt(task, currentContent);
        const genResult = await genAdapter.generateText(generatePrompt, {
          maxTokens: 4096,
          temperature: 0.7,
          timeoutMs: config.timeoutMs,
        });
        const generatedContent = genResult.text.trim();

        // Reflect phase (stateless = new adapter to prevent drift)
        const reflectAdapter = config.stateless
          ? (await this.llmFactory.createAdapterWithFailover()).adapter
          : genAdapter;

        const reflectPrompt = buildReflectPrompt(task, generatedContent, config.sentinelToken);
        const reflectResult = await reflectAdapter.generateText(reflectPrompt, {
          maxTokens: 2048,
          temperature: 0.3,
          timeoutMs: config.timeoutMs,
        });
        const reflection = reflectResult.text.trim();

        // Check sentinel
        const sentinelMatched = config.sentinelToken
          ? reflection.includes(config.sentinelToken)
          : false;

        // Determine if approved via ILlmJudge.judgeBinary (S2-11 fix: no keyword heuristic)
        const approved = await this.isApproved(reflection, correlationId);
        const shouldStop = sentinelMatched || approved;

        const iteration: ReflectionIteration = {
          iterationNumber: i,
          generatedContent,
          reflection,
          action: shouldStop ? 'stop' : 'continue',
          sentinelMatched,
        };
        iterations.push(iteration);

        // Emit per-iteration event
        const iterEvent = EventFactory.createBaseEvent(
          'reflection-loop',
          'agentic.reflection.iteration',
          {
            iterationNumber: i,
            action: iteration.action,
            sentinelMatched,
            contentLength: generatedContent.length,
          },
          correlationId,
        );
        await this.eventStore.saveEvents([iterEvent]);

        currentContent = generatedContent;

        if (sentinelMatched) {
          stoppedBy = 'sentinel';
          break;
        }
        if (approved) {
          stoppedBy = 'approved';
          break;
        }
      } catch (error) {
        this.logger.error('ReflectionLoop iteration failed', {
          correlationId,
          iteration: i,
          error: error instanceof Error ? error.message : String(error),
        });

        // If we have at least one successful iteration, return partial result
        if (iterations.length > 0) {
          stoppedBy = 'max_iterations';
          break;
        }

        // No iterations completed — propagate as domain error
        throw new ReasoningTimeoutError(
          `ReflectionLoop failed on first iteration: ${error instanceof Error ? error.message : String(error)}`,
          correlationId,
        );
      }
    }

    // Emit completion event
    const completionEvent = EventFactory.createBaseEvent(
      'reflection-loop',
      'agentic.reflection.completed',
      {
        totalIterations: iterations.length,
        stoppedBy,
        finalContentLength: currentContent.length,
      },
      correlationId,
    );
    await this.eventStore.saveEvents([completionEvent]);

    this.logger.info('ReflectionLoop completed', {
      correlationId,
      totalIterations: iterations.length,
      stoppedBy,
    });

    return {
      finalContent: currentContent,
      iterations,
      totalIterations: iterations.length,
      stoppedBy,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * S2-11 fix: Use ILlmJudge.judgeBinary() instead of keyword heuristic.
   * The old approach used positiveSignals/negativeSignals arrays, which
   * caused false negatives (e.g. "meets all needs" triggered by "needs").
   *
   * @see 36_S2_AUDIT_ANALYSIS_SOTA.md §4 — "S2-11: ReflectionLoop keyword heuristic"
   */
  private async isApproved(reflection: string, correlationId: CorrelationId): Promise<boolean> {
    try {
      return await this.judge.judgeBinary(
        reflection,
        'Does this reflection confirm that the content is excellent and needs no further changes? ' +
          'Return true only if the reviewer explicitly states there are no improvements needed.',
        correlationId,
      );
    } catch (error) {
      // Fallback: if judge fails, don't approve — let the loop continue
      this.logger.warn('ReflectionLoop: judgeBinary failed, defaulting to not-approved', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
