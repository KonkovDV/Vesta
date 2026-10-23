/**
 * PromptClassifierAdapter — Infrastructure adapter for IPromptClassifier.
 *
 * Uses a two-tier approach:
 * 1. Fast keyword/heuristic classification (no LLM cost)
 * 2. LLM fallback when heuristic confidence is low
 *
 * @layer Infrastructure (implements Domain port)
 * @see IPromptClassifier (src/domain/routing/prompt-classifier.interface.ts)
 * @see Book Ch.2 "Prompt Engineering" — Prompt Complexity Classifier (pp.28-45)
 */

import type {
  IPromptClassifier,
  ClassificationResult,
  ClassifyOptions,
  PromptComplexity,
} from '../../domain/routing/prompt-classifier.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { CorrelationId } from '../../core/types/branded';
import { ClassificationError } from '../../domain/errors/agentic-errors';

// ── Heuristic keyword maps ──────────────────────────────────────────

const REASONING_KEYWORDS = [
  'debug', 'fix', 'refactor', 'optimize', 'implement', 'code',
  'algorithm', 'solve', 'calculate', 'prove', 'analyze', 'compare',
  'explain why', 'step by step', 'logic',
];

const RESEARCH_KEYWORDS = [
  'research', 'search', 'find', 'look up', 'investigate', 'explore',
  'survey', 'review literature', 'state of the art', 'compare alternatives',
  'deep dive', 'comprehensive',
];

const CREATIVE_KEYWORDS = [
  'write', 'compose', 'create', 'design', 'brainstorm', 'imagine',
  'story', 'poem', 'essay', 'generate content', 'creative',
];

/** Confidence threshold below which we fall back to LLM classification. */
const HEURISTIC_CONFIDENCE_THRESHOLD = 0.6;

// ── Model mapping per complexity tier ───────────────────────────────

const DEFAULT_MODEL_MAP: Record<PromptComplexity, string> = {
  simple: 'gpt-4o-mini',
  reasoning: 'o3-mini',
  creative: 'gpt-4o',
  research: 'gpt-4o',
};

// ── Adapter ─────────────────────────────────────────────────────────

export class PromptClassifierAdapter implements IPromptClassifier {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly logger: ILogger,
    private readonly eventStore: IEventStore,
  ) {}

  async classify(
    prompt: string,
    correlationId: CorrelationId,
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    if (!prompt || prompt.trim().length === 0) {
      throw new ClassificationError('Cannot classify empty prompt', correlationId);
    }

    const startMs = Date.now();

    // Tier 1: Fast heuristic classification
    const heuristic = this.classifyByHeuristic(prompt);

    let result: ClassificationResult;

    if (heuristic.confidence >= HEURISTIC_CONFIDENCE_THRESHOLD) {
      // High-confidence heuristic — skip LLM call
      result = {
        ...heuristic,
        suggestedModel: options?.preferredModel ?? DEFAULT_MODEL_MAP[heuristic.complexity],
        reasoning: `Heuristic classification (confidence ${heuristic.confidence.toFixed(2)})`,
      };
    } else {
      // Tier 2: LLM fallback for ambiguous prompts
      try {
        result = await this.classifyByLlm(prompt, correlationId, options);
      } catch (error) {
        // If LLM fails, use heuristic with lower confidence
        this.logger.warn('PromptClassifier LLM fallback failed, using heuristic', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        result = {
          ...heuristic,
          suggestedModel: options?.preferredModel ?? DEFAULT_MODEL_MAP[heuristic.complexity],
          reasoning: `Heuristic fallback after LLM error (confidence ${heuristic.confidence.toFixed(2)})`,
        };
      }
    }

    // Emit classification event via Outbox
    const event = EventFactory.createBaseEvent(
      'prompt-classifier',
      'agentic.classification.completed',
      {
        complexity: result.complexity,
        confidence: result.confidence,
        suggestedModel: result.suggestedModel ?? undefined,
        requiresTools: result.requiresTools,
        usedLlm: result.reasoning.includes('LLM'),
        durationMs: Date.now() - startMs,
      },
      correlationId,
    );
    await this.eventStore.saveEvents([event]);

    this.logger.info('PromptClassifier classification completed', {
      correlationId,
      complexity: result.complexity,
      confidence: result.confidence,
    });

    return result;
  }

  // ── Tier 1: Keyword heuristic ─────────────────────────────────────

  private classifyByHeuristic(prompt: string): Omit<ClassificationResult, 'suggestedModel' | 'reasoning'> & { reasoning: string } {
    const lower = prompt.toLowerCase();
    const wordCount = prompt.split(/\s+/).length;

    let complexity: PromptComplexity = 'simple';
    let confidence = 0.4;
    let requiresTools = false;

    // Score each category
    const reasoningScore = this.keywordScore(lower, REASONING_KEYWORDS);
    const researchScore = this.keywordScore(lower, RESEARCH_KEYWORDS);
    const creativeScore = this.keywordScore(lower, CREATIVE_KEYWORDS);

    if (researchScore > reasoningScore && researchScore > creativeScore && researchScore > 0) {
      complexity = 'research';
      confidence = Math.min(0.9, 0.5 + researchScore * 0.15);
      requiresTools = true;
    } else if (reasoningScore > creativeScore && reasoningScore > 0) {
      complexity = 'reasoning';
      confidence = Math.min(0.9, 0.5 + reasoningScore * 0.15);
      requiresTools = reasoningScore > 2;
    } else if (creativeScore > 0) {
      complexity = 'creative';
      confidence = Math.min(0.9, 0.5 + creativeScore * 0.15);
    } else if (wordCount <= 10) {
      complexity = 'simple';
      confidence = 0.7;
    }

    // Estimate tokens based on complexity
    const estimatedTokens = {
      simple: 200,
      reasoning: 1500,
      creative: 1000,
      research: 3000,
    }[complexity];

    return {
      complexity,
      confidence,
      requiresTools,
      reasoning: 'heuristic',
      estimatedTokens,
    };
  }

  private keywordScore(text: string, keywords: string[]): number {
    return keywords.reduce((score, kw) => score + (text.includes(kw) ? 1 : 0), 0);
  }

  // ── Tier 2: LLM classification ────────────────────────────────────

  private async classifyByLlm(
    prompt: string,
    correlationId: CorrelationId,
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    const { adapter } = await this.llmFactory.createAdapterWithFailover();

    const systemPrompt = [
      'You are a prompt complexity classifier. Classify the user prompt into one of these categories:',
      '- "simple": factual questions, greetings, short answers',
      '- "reasoning": coding, debugging, math, logic, analysis',
      '- "creative": writing, brainstorming, design, content creation',
      '- "research": multi-source investigation, surveys, deep dives',
      '',
      'Respond with JSON only:',
      '{ "complexity": "<category>", "confidence": <0-1>, "requiresTools": <bool>, "reasoning": "<why>", "estimatedTokens": <number> }',
    ].join('\n');

    const llmResult = await adapter.generateText(prompt, {
      systemPrompt,
      temperature: 0.0,
      maxTokens: 256,
    });

    const jsonMatch = llmResult.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new ClassificationError('LLM did not return valid JSON', correlationId);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const complexity = this.normalizeComplexity(parsed.complexity);

    return {
      complexity,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      suggestedModel: options?.preferredModel ?? DEFAULT_MODEL_MAP[complexity],
      requiresTools: parsed.requiresTools === true,
      reasoning: `LLM classification: ${String(parsed.reasoning ?? '')}`,
      estimatedTokens: Number(parsed.estimatedTokens) || undefined,
    };
  }

  private normalizeComplexity(value: unknown): PromptComplexity {
    const s = String(value).toLowerCase();
    if (s === 'simple' || s === 'reasoning' || s === 'creative' || s === 'research') return s;
    return 'simple';
  }
}
