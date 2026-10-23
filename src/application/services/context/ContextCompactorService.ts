/**
 * ContextCompactorService — Application service implementing IContextCompactor.
 *
 * SOTA 2026 Extraction: Implements the "Information Crystal" pattern from ReDel Framework.
 * Instead of passing full documents through agent context windows, the Orchestrator
 * delegates to this service to produce compressed, fact-dense summaries.
 *
 * Strategies:
 *   - sliding_window: Keep last N messages (fast, stateless)
 *   - summarization: LLM-based compression to target token count
 *   - importance_based: Score messages by information density, keep top-K
 *   - hybrid: Combine sliding_window + summarization for optimal balance
 *
 * Integration Point:
 *   MasterAgentFanout → IContextCompactor.compact() → Information Crystal → Agent
 *
 * Academic References:
 *   - Liu et al. (2025) "ReDel: Recursive Delegation for Multi-Agent Systems"
 *   - Xu et al. (2024) "Lost in the Middle: How LLMs Use Long Contexts" (TACL)
 *
 * @layer Application (service — orchestrates domain interface)
 * @horizon H2: Deep Agent Recursive Delegation
 * @see src/domain/context/context-compactor.interface.ts — domain port
 * @see src/infrastructure/context/hermes-context-compressor.ts — existing compression
 */

import type {
  IContextCompactor,
  ConversationContext,
  CompactionOptions,
  CompactedContext,
  CompactionStrategy,
} from '@/domain/context/context-compactor.interface';

// ── Minimal Dependencies ──────────────────────────────────────────

interface CompactorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Optional LLM summarizer for summarization strategy.
 * If not provided, falls back to truncation-based compaction.
 */
interface ISummarizer {
  summarize(text: string, targetTokens: number): Promise<string>;
}

// ── Token Estimation ──────────────────────────────────────────────

/**
 * Lightweight token estimator (~4 chars per token for English text).
 * Used when no tokenizer is available.
 */
function estimateTokensSimple(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(
  messages: ConversationContext['messages'],
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokensSimple(m.content ?? '');
    total += 4; // role overhead
  }
  return total;
}

// ── Importance Scoring ────────────────────────────────────────────

interface ScoredMessage {
  readonly index: number;
  readonly score: number;
}

/**
 * Heuristic importance scorer for messages.
 * Higher score = more important to keep.
 */
function scoreMessage(
  message: ConversationContext['messages'][0],
  index: number,
  total: number,
): number {
  let score = 0;

  // System messages are critical
  if (message.role === 'system') return 1000;

  // First user message has high context value
  if (index === 0) score += 50;

  // Recent messages are more relevant (recency bias)
  score += (index / total) * 30;

  // Tool results carry implementation context
  if (message.role === 'tool') score += 10;
  if (message.tool_calls && message.tool_calls.length > 0) score += 15;

  // Longer messages likely contain more context
  const contentLength = (message.content ?? '').length;
  if (contentLength > 500) score += 10;
  if (contentLength > 2000) score += 5;

  // Messages mentioning code artifacts (interfaces, DI, imports)
  const content = message.content ?? '';
  if (/interface\s+\w+|DI_TOKENS|import.*from/.test(content)) score += 20;

  return score;
}

// ── Implementation ────────────────────────────────────────────────

export class ContextCompactorService implements IContextCompactor {
  private strategy: CompactionStrategy = 'hybrid';

  constructor(
    private readonly summarizer?: ISummarizer,
    private readonly logger?: CompactorLogger,
  ) {}

  async compact(
    context: ConversationContext,
    options?: CompactionOptions,
  ): Promise<CompactedContext> {
    const strategy = options?.strategy ?? this.strategy;
    const originalTokens = this.estimateTokens(context);
    const targetTokens = options?.targetTokens ?? Math.ceil(originalTokens * 0.25);
    const minMessages = options?.minMessages ?? 3;

    // If already under target, no compaction needed
    if (originalTokens <= targetTokens) {
      return {
        conversationId: context.conversationId,
        messages: [...context.messages],
        originalTokens,
        compactedTokens: originalTokens,
        strategy: 'none',
      };
    }

    this.logger?.info(`ContextCompactor: ${originalTokens} tokens → target ${targetTokens} (strategy: ${strategy})`, {
      conversationId: context.conversationId,
    });

    switch (strategy) {
      case 'sliding_window':
        return this.slidingWindow(context, targetTokens, minMessages);

      case 'summarization':
        return this.summarization(context, targetTokens, minMessages);

      case 'importance_based':
        return this.importanceBased(context, targetTokens, minMessages);

      case 'hybrid':
        return this.hybrid(context, targetTokens, minMessages);

      default:
        return this.slidingWindow(context, targetTokens, minMessages);
    }
  }

  estimateTokens(context: ConversationContext): number {
    let total = 0;
    if (context.systemPrompt) {
      total += estimateTokensSimple(context.systemPrompt);
    }
    total += estimateMessageTokens(context.messages);
    return total;
  }

  getCompactionStrategy(): CompactionStrategy {
    return this.strategy;
  }

  setCompactionStrategy(strategy: CompactionStrategy): void {
    this.strategy = strategy;
  }

  // ── Strategy Implementations ────────────────────────────────────

  private async slidingWindow(
    context: ConversationContext,
    targetTokens: number,
    minMessages: number,
  ): Promise<CompactedContext> {
    const messages = [...context.messages];

    // Preserve system messages at the start
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // Take from the tail until we hit target
    const kept = [...systemMessages];
    let currentTokens = estimateMessageTokens(systemMessages);

    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokensSimple(nonSystem[i].content ?? '') + 4;
      if (currentTokens + msgTokens > targetTokens && kept.length >= minMessages) {
        break;
      }
      kept.unshift(nonSystem[i]);
      currentTokens += msgTokens;
    }

    return {
      conversationId: context.conversationId,
      messages: kept,
      originalTokens: this.estimateTokens(context),
      compactedTokens: currentTokens,
      strategy: 'sliding_window',
    };
  }

  private async summarization(
    context: ConversationContext,
    targetTokens: number,
    minMessages: number,
  ): Promise<CompactedContext> {
    if (!this.summarizer) {
      // Fallback to sliding window if no summarizer available
      this.logger?.warn('ContextCompactor: No summarizer available, falling back to sliding_window');
      return this.slidingWindow(context, targetTokens, minMessages);
    }

    const messages = [...context.messages];
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // Keep recent messages (tail), summarize the rest
    const recentCount = Math.max(minMessages, Math.ceil(nonSystem.length * 0.3));
    const recent = nonSystem.slice(-recentCount);
    const toSummarize = nonSystem.slice(0, -recentCount);

    if (toSummarize.length === 0) {
      return this.slidingWindow(context, targetTokens, minMessages);
    }

    // Build text for summarization
    const summaryInput = toSummarize
      .map(m => `[${m.role}]: ${(m.content ?? '').slice(0, 2000)}`)
      .join('\n\n');

    const summaryTargetTokens = Math.max(200, Math.ceil(targetTokens * 0.3));
    const summary = await this.summarizer.summarize(summaryInput, summaryTargetTokens);

    const summaryMessage = {
      role: 'system' as const,
      content: `[CONTEXT_SUMMARY] The following is a compressed summary of earlier conversation:\n${summary}`,
    };

    const compacted = [...systemMessages, summaryMessage, ...recent];
    const compactedTokens = estimateMessageTokens(compacted);

    return {
      conversationId: context.conversationId,
      messages: compacted,
      originalTokens: this.estimateTokens(context),
      compactedTokens,
      strategy: 'summarization',
      summary,
    };
  }

  private async importanceBased(
    context: ConversationContext,
    targetTokens: number,
    minMessages: number,
  ): Promise<CompactedContext> {
    const messages = [...context.messages];
    const total = messages.length;

    // Score each message
    const scored: ScoredMessage[] = messages.map((m, i) => ({
      index: i,
      score: scoreMessage(m, i, total),
    }));

    // Sort by score descending
    const sorted = [...scored].sort((a, b) => b.score - a.score);

    // Keep messages until we hit target token budget
    const keepIndices = new Set<number>();
    let currentTokens = 0;

    for (const item of sorted) {
      const msgTokens = estimateTokensSimple(messages[item.index].content ?? '') + 4;
      if (currentTokens + msgTokens > targetTokens && keepIndices.size >= minMessages) {
        break;
      }
      keepIndices.add(item.index);
      currentTokens += msgTokens;
    }

    // Reconstruct in original order
    const compacted = messages.filter((_, i) => keepIndices.has(i));

    return {
      conversationId: context.conversationId,
      messages: compacted,
      originalTokens: this.estimateTokens(context),
      compactedTokens: currentTokens,
      strategy: 'importance_based',
    };
  }

  private async hybrid(
    context: ConversationContext,
    targetTokens: number,
    minMessages: number,
  ): Promise<CompactedContext> {
    // Phase 1: Use importance scoring to drop low-value messages
    const midTarget = Math.ceil(targetTokens * 1.5); // Allow extra room
    const importanceResult = await this.importanceBased(context, midTarget, minMessages);

    // Phase 2: If still over target, apply summarization on the result
    if (importanceResult.compactedTokens > targetTokens && this.summarizer) {
      const midContext: ConversationContext = {
        conversationId: context.conversationId,
        messages: importanceResult.messages,
        systemPrompt: context.systemPrompt,
        metadata: context.metadata,
      };
      const result = await this.summarization(midContext, targetTokens, minMessages);
      return { ...result, strategy: 'hybrid' };
    }

    // Phase 2 fallback: sliding window
    if (importanceResult.compactedTokens > targetTokens) {
      const midContext: ConversationContext = {
        conversationId: context.conversationId,
        messages: importanceResult.messages,
        systemPrompt: context.systemPrompt,
        metadata: context.metadata,
      };
      const result = await this.slidingWindow(midContext, targetTokens, minMessages);
      return { ...result, strategy: 'hybrid' };
    }

    return { ...importanceResult, strategy: 'hybrid' };
  }
}
