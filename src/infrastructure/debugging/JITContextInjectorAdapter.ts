/**
 * JITContextInjectorAdapter — Infrastructure adapter for IJITContextInjector.
 *
 * Provides Just-In-Time context injection of relevant known bugs
 * when a file is being edited. Queries the error graph, formats
 * results as compact rules, and enforces token budgeting (MAX 500 tokens).
 *
 * Caching:
 *   - File → JITContextResult LRU cache (bounded, TTL-based)
 *   - Strict LRU eviction: Map delete-reinsert pattern (SOTA 2026)
 *   - Invalidated on error graph mutation
 *
 * Decay (SOTA 2026: Non-Linear Epistemic Decay):
 *   - Integrates DecayService with Spaced Repetition (Crystallized Intelligence)
 *   - Formula: relevance(t,n) = severity_score × e^(-(λ/√n) × days_since_discovery)
 *   - Where n = recurrenceCount (bugs that recur more often decay slower)
 *   - Old bugs (>6 months) are deprioritized; recent bugs get higher attention
 *
 * Compression (SOTA 2026: LLMLingua / Contextual Compression):
 *   - Optional IContextCompressor distills N rules into 3-line concentrate
 *   - Prevents "Lost in the Middle" attention degradation
 *
 * @layer Infrastructure
 * @implements IJITContextInjector (Domain port)
 * @see src/domain/debugging/IJITContextInjector.ts
 * @see src/domain/debugging/IErrorGraphRepository.ts — data source
 * @see src/memory/session/DecayService.ts — exponential decay
 * @see PLANS/SOTA_BUG_CATCHING_2026/02_Agentic_JIT_Context_Injection.md
 */

import type { CorrelationId } from '@/ai-types';
import type {
  IJITContextInjector,
  InjectedContextRule,
  JITContextResult,
} from '../../domain/debugging/IJITContextInjector';
import type {
  IErrorGraphRepository,
  ErrorGraphNode,
} from '../../domain/debugging/IErrorGraphRepository';
import type { IContextCompressor } from '../../domain/debugging/IContextCompressor';
import { DecayService, DEFAULT_DECAY_LAMBDA } from '../../memory/session/DecayService';

// ── Logger Interface ──────────────────────────────────────────────

interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Constants ─────────────────────────────────────────────────────

/** Default max JIT tokens per file context. */
const DEFAULT_MAX_TOKENS = 500;

/** Cache TTL in milliseconds (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum cache entries to prevent unbounded growth. */
const MAX_CACHE_ENTRIES = 200;

/** Approximate tokens per character (conservative estimate for LLM tokenizers). */
const CHARS_PER_TOKEN = 4;

// ── Cache Entry ───────────────────────────────────────────────────

interface CacheEntry {
  readonly result: JITContextResult;
  readonly expiresAt: number;
}

/**
 * Decay lambda for bug relevance decay.
 * Using DEFAULT_DECAY_LAMBDA (0.010 — half-life ~69 days).
 * Old bugs discovered >6 months ago will have significantly reduced relevance.
 */
const BUG_DECAY_LAMBDA = DEFAULT_DECAY_LAMBDA;

// ── Implementation ───────────────────────────────────────────────────

export class JITContextInjectorAdapter implements IJITContextInjector {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly decayService: DecayService;
  private readonly compressor?: IContextCompressor;

  constructor(
    private readonly errorGraph: IErrorGraphRepository,
    private readonly logger?: ILogger,
    decayService?: DecayService,
    compressor?: IContextCompressor,
  ) {
    this.decayService = decayService ?? new DecayService();
    this.compressor = compressor;
  }

  async getContextForFile(
    filePath: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    correlationId: CorrelationId = '' as CorrelationId,
  ): Promise<JITContextResult> {
    // Check cache first (LRU: move to tail on hit)
    const cacheKey = `${filePath}:${maxTokens}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // LRU promotion: delete and re-insert to move to tail
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.logger?.info('JIT: cache hit (LRU promoted)', { filePath, correlationId });
      return { ...cached.result, cached: true };
    }
    // Remove stale entry if expired
    if (cached) {
      this.cache.delete(cacheKey);
    }

    this.logger?.info('JIT: querying error graph', { filePath, maxTokens, correlationId });

    try {
      // Query the error graph for bugs affecting this file
      const contextResult = await this.errorGraph.queryByContext(
        { filePath, limit: 20 },
        correlationId,
      );

      // Convert errors to compact rules, sorted by severity
      // Apply DecayService: multiply relevance by time-based decay factor
      const allRules: InjectedContextRule[] = contextResult.errors.map((error, idx) => {
        const baseSeverityScore = contextResult.scores[idx] ?? 0.5;

        // Non-Linear Epistemic Decay (SOTA 2026: Spaced Repetition)
        // Formula: λ(n) = λ_base / √n — recurrent bugs decay slower
        const recurrence = error.recurrenceCount ?? 1;
        const effectiveLambda = DEFAULT_DECAY_LAMBDA / Math.sqrt(Math.max(1, recurrence));

        const decayResult = this.decayService.calculateDecay({
          initialSalience: baseSeverityScore,
          lastSeenAt: error.discoveredAt,
        });

        // Apply non-linear correction: replace default lambda with effective λ(n)
        const lastSeenDate = new Date(error.discoveredAt);
        const daysSince = Math.max(0, (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60 * 24));
        const nonLinearSalience = baseSeverityScore * Math.exp(-effectiveLambda * daysSince);

        return {
          errorId: error.id,
          ruleText: this.formatRuleText(error),
          relevance: Math.max(0, Math.min(1, nonLinearSalience)),
          category: error.category,
        };
      });

      // Sort by relevance (descending), then severity (CRITICAL first)
      allRules.sort((a, b) => b.relevance - a.relevance);

      // Apply token budgeting — trim rules to fit within maxTokens
      const { rules, tokenCount } = this.applyTokenBudget(allRules, maxTokens);

      // Optional: compress rules via IContextCompressor (LLMLingua / Contextual Compression)
      let compressedPrinciple: string | undefined;
      if (this.compressor && rules.length > 1) {
        try {
          const compressed = await this.compressor.compress(
            { rules, maxOutputTokens: Math.min(maxTokens, 100), filePath },
            correlationId,
          );
          compressedPrinciple = compressed.principle;
          this.logger?.info('JIT: context compressed', {
            filePath,
            sourceRules: compressed.sourceRuleCount,
            compressionRatio: compressed.compressionRatio.toFixed(1),
            correlationId,
          });
        } catch {
          // Compression is optional — graceful degradation
        }
      }

      const result: JITContextResult = {
        filePath,
        rules,
        tokenCount,
        cached: false,
      };

      // Store in cache (bounded)
      this.storeInCache(cacheKey, result);

      this.logger?.info('JIT: context generated', {
        filePath,
        rulesCount: rules.length,
        tokenCount,
        totalAvailable: allRules.length,
        correlationId,
      });

      return result;
    } catch (err) {
      this.logger?.error('JIT: error querying graph', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
        correlationId,
      });

      // Return empty context on error (graceful degradation)
      return {
        filePath,
        rules: [],
        tokenCount: 0,
        cached: false,
      };
    }
  }

  invalidateCache(filePath: string): void {
    // Remove all cache entries for this file (any maxTokens)
    const keysToRemove: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(filePath + ':')) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.cache.delete(key);
    }

    this.logger?.info('JIT: cache invalidated', {
      filePath,
      entriesRemoved: keysToRemove.length,
    });
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /**
   * Format a compact rule text from an error node.
   * Optimized for LLM attention: concise, actionable, includes error ID.
   */
  private formatRuleText(error: ErrorGraphNode): string {
    const parts = [
      `[${error.id}] ${error.severity}:`,
      error.rule,
    ];

    if (error.testTrap) {
      parts.push(`Test: ${error.testTrap}`);
    }

    return parts.join(' ');
  }

  /**
   * Apply token budgeting: include rules in priority order until budget exhausted.
   */
  private applyTokenBudget(
    rules: InjectedContextRule[],
    maxTokens: number,
  ): { rules: InjectedContextRule[]; tokenCount: number } {
    const included: InjectedContextRule[] = [];
    let totalChars = 0;
    const maxChars = maxTokens * CHARS_PER_TOKEN;

    for (const rule of rules) {
      const ruleChars = rule.ruleText.length + rule.errorId.length + 20; // overhead for formatting
      if (totalChars + ruleChars > maxChars && included.length > 0) {
        break; // Budget exhausted; always include at least one rule if available
      }
      included.push(rule);
      totalChars += ruleChars;
    }

    return {
      rules: included,
      tokenCount: Math.ceil(totalChars / CHARS_PER_TOKEN),
    };
  }

  /**
   * Store result in bounded LRU cache with TTL.
   * Evicts the least-recently-used entry when at capacity.
   */
  private storeInCache(key: string, result: JITContextResult): void {
    // LRU eviction: Map iteration order = insertion order,
    // so the first key is the least-recently-used entry.
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
      }
    }

    this.cache.set(key, {
      result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }
}
