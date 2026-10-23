/**
 * LlmJudgeAdapter — Infrastructure adapter for ILlmJudge.
 *
 * Uses LLMAdapterFactory to call LLM with structured evaluation prompt,
 * parses JSON response into JudgmentResult, emits events via IEventStore.
 *
 * @layer Infrastructure (implements Domain port)
 * @see ILlmJudge (src/domain/evaluation/llm-judge.interface.ts)
 * @see Book Ch.19 "Evaluation & Testing" — LLM-as-Judge with structured rubric
 */

import type {
  ILlmJudge,
  EvaluationRubric,
  JudgmentResult,
} from '../../domain/evaluation/llm-judge.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { CorrelationId } from '../../core/types/branded';
import { EvaluationFailedError } from '../../domain/errors/agentic-errors';

// ── Prompt templates ────────────────────────────────────────────────

function buildRubricPrompt(content: string, rubric: EvaluationRubric): string {
  const criteriaLines = rubric.criteria.map(
    (c, i) =>
      `${i + 1}. "${c.name}": ${c.description} (scale ${c.scale.min}-${c.scale.max}, weight ${c.weight ?? 1.0})`,
  );

  return [
    'You are an expert evaluator. Evaluate the following content against the given rubric.',
    '',
    '=== CONTENT ===',
    content,
    '',
    '=== RUBRIC ===',
    ...criteriaLines,
    '',
    'Respond in JSON only (no markdown fences):',
    '{',
    '  "overallScore": <weighted average>,',
    '  "criterionScores": { "<criterion_name>": <score>, ... },',
    '  "rationale": "<free-text rationale>",',
    '  "concerns": ["<concern1>", ...],',
    '  "recommendedAction": "approve" | "revise" | "reject",',
    '  "confidence": <0-1>',
    '}',
  ].join('\n');
}

function buildBinaryPrompt(content: string, criteria: string): string {
  return [
    'You are an expert evaluator. Determine if the following content passes the given criterion.',
    '',
    `Criterion: ${criteria}`,
    '',
    '=== CONTENT ===',
    content,
    '',
    'Respond with a single JSON object: { "pass": true } or { "pass": false }',
  ].join('\n');
}

// ── Adapter ─────────────────────────────────────────────────────────

export class LlmJudgeAdapter implements ILlmJudge {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly logger: ILogger,
    private readonly eventStore: IEventStore,
  ) {}

  async judge(
    content: string,
    rubric: EvaluationRubric,
    correlationId: CorrelationId,
  ): Promise<JudgmentResult> {
    const startMs = Date.now();

    try {
      const prompt = buildRubricPrompt(content, rubric);
      const { adapter } = await this.llmFactory.createAdapterWithFailover();
      const llmResult = await adapter.generateText(prompt, {
        temperature: 0.1,
        maxTokens: 2048,
        systemPrompt: 'You are a strict, fair evaluator. Output valid JSON only.',
      });

      const parsed = this.parseJudgment(llmResult.text);

      // Emit success event via Outbox-first pattern
      const event = EventFactory.createBaseEvent(
        'llm-judge',
        'agentic.judge.completed',
        {
          criteriaCount: rubric.criteria.length,
          overallScore: parsed.overallScore,
          recommendedAction: parsed.recommendedAction,
          confidence: parsed.confidence,
          durationMs: Date.now() - startMs,
          tokensUsed: llmResult.usage?.totalTokens ?? 0,
        },
        correlationId,
      );
      await this.eventStore.saveEvents([event]);

      this.logger.info('LlmJudge evaluation completed', {
        correlationId,
        overallScore: parsed.overallScore,
        action: parsed.recommendedAction,
      });

      return parsed;
    } catch (error) {
      // Emit failure event
      const failEvent = EventFactory.createBaseEvent(
        'llm-judge',
        'agentic.judge.failed',
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startMs,
        },
        correlationId,
      );
      await this.eventStore.saveEvents([failEvent as DomainEvent]).catch(() => {
        /* best-effort */
      });

      this.logger.error('LlmJudge evaluation failed', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new EvaluationFailedError(
        `LLM Judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        correlationId,
      );
    }
  }

  async judgeBinary(
    content: string,
    criteria: string,
    correlationId: CorrelationId,
  ): Promise<boolean> {
    try {
      const prompt = buildBinaryPrompt(content, criteria);
      const { adapter } = await this.llmFactory.createAdapterWithFailover();
      const llmResult = await adapter.generateText(prompt, {
        temperature: 0.0,
        maxTokens: 64,
        systemPrompt: 'Respond with JSON only: { "pass": true } or { "pass": false }',
      });

      const raw = llmResult.text.trim();
      // Try to extract JSON from possibly wrapped response
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return false;

      const parsed = JSON.parse(jsonMatch[0]) as { pass: boolean };
      return parsed.pass === true;
    } catch (error) {
      this.logger.warn('LlmJudge binary evaluation failed, returning false', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  private parseJudgment(raw: string): JudgmentResult {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM response does not contain valid JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    return {
      overallScore: Number(parsed.overallScore) || 0,
      criterionScores: (parsed.criterionScores as Record<string, number>) ?? {},
      rationale: String(parsed.rationale ?? ''),
      concerns: Array.isArray(parsed.concerns)
        ? parsed.concerns.map(String)
        : [],
      recommendedAction: this.normalizeAction(parsed.recommendedAction),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    };
  }

  private normalizeAction(
    value: unknown,
  ): 'approve' | 'revise' | 'reject' {
    const s = String(value).toLowerCase();
    if (s === 'approve' || s === 'revise' || s === 'reject') return s;
    return 'revise'; // safe default
  }
}
