/**
 * LlmTestHarnessAdapter — In-memory deterministic LLM response mocking/replay.
 *
 * In-memory implementation of ILlmTestHarness. Captures or replays LLM
 * prompt-response pairs using content-hash matching. Supports fuzzy matching
 * via a simple character-level similarity metric.
 *
 * @layer Infrastructure (AI)
 * @pattern CC-018 LLM Test Harness (FITNESS-K: 85)
 * @see src/domain/ai/ILlmTestHarness.ts — domain port
 * @see src/core/events/llm-test-harness.schemas.ts — Zod validation schemas
 */

import type {
  ILlmTestHarness,
  HarnessMode,
  PromptResponsePair,
  TestCassette,
  ReplayResult,
  HarnessMiss,
  HarnessStats,
} from '../../domain/ai/ILlmTestHarness';

// ── Minimal Logger ────────────────────────────────────────────────

interface HarnessLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

export class LlmTestHarnessAdapter implements ILlmTestHarness {
  private mode: HarnessMode = 'passthrough';
  private readonly recordedPairs: PromptResponsePair[] = [];
  private readonly misses: HarnessMiss[] = [];
  private activeCassette: TestCassette | null = null;
  private pairCounter = 0;
  private totalRequests = 0;
  private hits = 0;

  constructor(private readonly logger?: HarnessLogger) {}

  setMode(mode: HarnessMode): void {
    this.mode = mode;
    this.logger?.info('Harness mode set', { mode });
  }

  getMode(): HarnessMode {
    return this.mode;
  }

  loadCassette(cassette: TestCassette): void {
    this.activeCassette = cassette;
    this.logger?.info('Cassette loaded', { cassetteId: cassette.cassetteId, pairs: cassette.pairs.length });
  }

  recordPair(
    promptText: string,
    modelId: string,
    response: string,
    latencyMs: number,
    tokenUsage: { promptTokens: number; completionTokens: number },
  ): PromptResponsePair {
    const pair: PromptResponsePair = {
      pairId: `pair-${++this.pairCounter}`,
      promptHash: this.hashPrompt(promptText),
      promptText,
      modelId,
      response,
      recordedAt: new Date().toISOString(),
      latencyMs,
      tokenUsage,
    };
    this.recordedPairs.push(pair);
    this.logger?.info('Pair recorded', { pairId: pair.pairId, modelId });
    return pair;
  }

  replay(promptText: string, modelId: string, similarityThreshold?: number): ReplayResult {
    this.totalRequests++;
    const threshold = similarityThreshold ?? 1.0;
    const hash = this.hashPrompt(promptText);

    const pairs = this.activeCassette?.pairs ?? this.recordedPairs;

    // Exact match first
    const exact = pairs.find(p => p.promptHash === hash && p.modelId === modelId);
    if (exact) {
      this.hits++;
      return { matched: true, response: exact.response, pairId: exact.pairId, similarityScore: 1.0 };
    }

    // Fuzzy match if threshold < 1.0
    if (threshold < 1.0) {
      let bestScore = 0;
      let bestPair: PromptResponsePair | null = null;
      for (const p of pairs) {
        if (p.modelId !== modelId) continue;
        const score = this.similarity(promptText, p.promptText);
        if (score > bestScore) {
          bestScore = score;
          bestPair = p;
        }
      }
      if (bestPair && bestScore >= threshold) {
        this.hits++;
        return { matched: true, response: bestPair.response, pairId: bestPair.pairId, similarityScore: bestScore };
      }
    }

    // Miss
    const closestScore = this.findClosestScore(promptText, modelId, pairs);
    this.misses.push({
      promptHash: hash,
      promptText,
      modelId,
      timestamp: new Date().toISOString(),
      closestMatchScore: closestScore.score,
      closestMatchPairId: closestScore.pairId,
    });

    return { matched: false, similarityScore: closestScore.score };
  }

  exportCassette(name: string, description?: string): TestCassette {
    return {
      cassetteId: `cas-${++this.pairCounter}`,
      name,
      description,
      pairs: [...this.recordedPairs],
      createdAt: new Date().toISOString(),
      modelId: this.recordedPairs[0]?.modelId ?? 'unknown',
      version: 1,
    };
  }

  getMisses(): readonly HarnessMiss[] {
    return [...this.misses];
  }

  getStats(): HarnessStats {
    const missCount = this.totalRequests - this.hits;
    return {
      totalRequests: this.totalRequests,
      hits: this.hits,
      misses: missCount,
      hitRate: this.totalRequests > 0 ? this.hits / this.totalRequests : 0,
      mode: this.mode,
      activeCassetteId: this.activeCassette?.cassetteId,
    };
  }

  reset(): void {
    this.recordedPairs.length = 0;
    this.misses.length = 0;
    this.activeCassette = null;
    this.totalRequests = 0;
    this.hits = 0;
    this.logger?.info('Harness reset');
  }

  // ── Internal ──────────────────────────────────────────────────

  private hashPrompt(text: string): string {
    // Simple deterministic hash for prompt matching
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `h${Math.abs(hash).toString(36)}`;
  }

  private similarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.length === 0 || b.length === 0) return 0;
    // Simple bigram similarity (Dice coefficient)
    const bigramsA = this.bigrams(a);
    const bigramsB = this.bigrams(b);
    let intersection = 0;
    const bSet = new Set(bigramsB);
    for (const bg of bigramsA) {
      if (bSet.has(bg)) intersection++;
    }
    return (2 * intersection) / (bigramsA.length + bigramsB.length);
  }

  private bigrams(text: string): string[] {
    const result: string[] = [];
    for (let i = 0; i < text.length - 1; i++) {
      result.push(text.substring(i, i + 2));
    }
    return result;
  }

  private findClosestScore(
    promptText: string,
    modelId: string,
    pairs: readonly PromptResponsePair[],
  ): { score: number; pairId?: string } {
    let bestScore = 0;
    let bestPairId: string | undefined;
    for (const p of pairs) {
      if (p.modelId !== modelId) continue;
      const score = this.similarity(promptText, p.promptText);
      if (score > bestScore) {
        bestScore = score;
        bestPairId = p.pairId;
      }
    }
    return { score: bestScore, pairId: bestPairId };
  }
}
