/**
 * SemanticPagingService — Application service for S-MMU (Semantic Memory Management Unit)
 * Layer: Infrastructure (context)
 *
 * Orchestrates multi-tier semantic memory retrieval. Queries 4 memory tiers
 * in parallel, merges results by relevance score, and trims to a token budget.
 *
 * Tier adapters are injected via constructor:
 *   - Tier 1 (main_context): Local structured data provider (optional)
 *   - Tier 2 (core_recall): IEventStore-based event history
 *   - Tier 3 (archival): Vector-search provider (optional)
 *   - Tier 4 (knowledge_graph): AST-driven graph traversal (optional, Phase 5.5)
 *
 * When a tier adapter is not available (null/undefined), that tier is
 * gracefully skipped and reported in `emptyTiers`.
 *
 * @Horizon 2 — Federation & Intelligence (Context Engineering)
 * @see src/domain/context/ISemanticPagingService.ts — port interface
 * @see src/domain/events/event-store.interface.ts — Tier 2 source
 */

import type {
  ISemanticPagingService,
  IMainContextProvider,
  IGraphContextProvider,
  SemanticPagingRequest,
  SemanticPagingResult,
  SemanticPage,
  MemoryTier,
  ContextFrame,
  TruncationSummary,
} from '@/domain/context/ISemanticPagingService';
import type { IEventStore, DomainEvent } from '@/domain/events/event-store.interface';
import type { IContextRelevanceJudge } from '@/domain/context/IContextRelevanceJudge';
import type { IContextQualityMetrics, ContextTierLabel } from '@/domain/context/IContextQualityMetrics';
import type { IHybridRetrievalService, HybridSearchResult } from '@/domain/context/IHybridRetrievalService';
import type { ITokenBudgetManager } from '@/domain/context/token-budget.interface';
import type { IArchivalMemory } from '@/domain/memory/IArchivalMemory';
import { getModelContextWindow } from '@/core/context/model-registry';

// ─── Tier Provider Interfaces ────────────────────────────────────────

export type { IMainContextProvider, IGraphContextProvider };

/** Minimal structured logger interface */
interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_MAX_PAGES = 5;
/**
 * Default token budget for S-MMU paging when no model is specified and no budget manager is available.
 * GAP-001 FIX: Raised from 4096 to 16384 to avoid unnecessary compression on modern 128k+ models.
 * When tokenBudgetManager is injected, this constant is only used as an absolute last-resort fallback.
 */
const DEFAULT_TOKEN_BUDGET = 16_384;
/** Rough estimate: 1 token ≈ 4 characters (English/code mix) */
const CHARS_PER_TOKEN = 4;

/** Cache TTL: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Maximum cache entries before LRU eviction */
const MAX_CACHE_SIZE = 100;
/** Timeout for tier queries to prevent indefinite hangs (PH-001) */
const TIER_QUERY_TIMEOUT_MS = 10_000;

/**
 * Dynamic Budget Steering: if Tier 1 achieves this average relevance score,
 * remaining tier budgets are reduced proportionally to save tokens and TTFT.
 *
 * @pattern Dynamic Budget Steering — SOTA 2026 Context Engineering
 * @see Anthropic (2025) "Matching search result quality to query intent"
 */
const STEERING_HIGH_RELEVANCE_THRESHOLD = 0.85;
/** Fraction to reduce remaining tier budget when steering activates (0.5 = halve budget). */
const STEERING_BUDGET_REDUCTION = 0.5;

/**
 * VEC-004: Incremental Saturation Gates.
 * If cumulative relevance×budget fill ratio exceeds this threshold after any tier,
 * skip remaining tiers entirely — they would add noise without improving quality.
 *
 * @pattern Incremental Saturation — SOTA 2026 Context Engineering
 */
const SATURATION_THRESHOLD = 0.90;
/** Minimum average relevance to trigger saturation gate (prevents premature cutoff). */
const SATURATION_MIN_RELEVANCE = 0.80;

/**
 * Common English stop words removed during query normalization.
 * Enables semantic deduplication of similar queries.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'after', 'before', 'above', 'below', 'and', 'but', 'or',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'this', 'that', 'these', 'those', 'it', 'its', 'what', 'which',
  'who', 'whom', 'how', 'when', 'where', 'why', 'all', 'each',
  'every', 'any', 'some', 'such',
]);

/** Cached query result entry */
interface CacheEntry {
  result: SemanticPagingResult;
  timestamp: number;
  hitCount: number;
  /** Generation at which this entry was written. Stale if < current cacheGeneration. */
  generation: number;
}

// ─── Service ─────────────────────────────────────────────────────────

/**
 * SemanticPagingService — S-MMU orchestrator.
 *
 * @example
 * Construct it through SemanticPagingServiceFactory.
 * const result = await smmu.getPage({ query: 'DI container topology', tokenBudget: 2048 });
 */
export class SemanticPagingService implements ISemanticPagingService {
  /** In-memory semantic cache: normalized query → result */
  private readonly queryCache = new Map<string, CacheEntry>();
  /** Monotonically increasing generation counter. Entries written under older generation are stale. */
  private cacheGeneration = 0;

  constructor(
    private readonly eventStore: IEventStore | undefined,
    private readonly mainContextProvider: IMainContextProvider | undefined,
    private readonly archivalProvider: IArchivalMemory | undefined,
    private readonly graphContextProvider?: IGraphContextProvider | undefined,
    private readonly logger?: ILogger,
    private readonly relevanceJudge?: IContextRelevanceJudge,
    private readonly hybridRetrieval?: IHybridRetrievalService,
    private readonly tokenBudgetManager?: ITokenBudgetManager,
    private readonly contextQualityMetrics?: IContextQualityMetrics,
    private readonly hybridRetrievalEnabled: boolean = true,
  ) {}

  /**
   * Explicitly invalidate the semantic cache.
   * Call when underlying data sources change (new events, new chunks)
   * to prevent serving stale results.
   */
  invalidateCache(): void {
    this.queryCache.clear();
    this.cacheGeneration++;
    this.logger?.info('smmu_cache_invalidated', { generation: this.cacheGeneration });
  }

  async getPage(request: SemanticPagingRequest): Promise<SemanticPagingResult> {
    const startMs = Date.now();
    const maxPages = request.maxPages ?? DEFAULT_MAX_PAGES;
    const tokenBudget = request.tokenBudget
      ?? this.computeModelAwareBudget(request.model)
      ?? DEFAULT_TOKEN_BUDGET;
    const requestedTiers = request.tiers ?? ['main_context', 'core_recall', 'archival', 'knowledge_graph'] as MemoryTier[];

    // ── Semantic cache lookup ───────────────────────────────────────
    // VEC-003: Include intent hash (word-order-sensitive) alongside sorted token key
    // to prevent semantic cache collisions for queries with same words but different intent.
    const cacheKey = this.buildCacheKey(request.query);
    const cached = this.getCachedResult(cacheKey, tokenBudget, maxPages);
    if (cached) {
      this.logger?.info('smmu_cache_hit', {
        query_length: request.query.length,
        cache_key: cacheKey,
        hit_count: cached.hitCount,
        correlation_id: request.correlationId,
      });
      this.contextQualityMetrics?.recordCacheAccess(true);
      return cached.result;
    }
    this.contextQualityMetrics?.recordCacheAccess(false);

    // ── Dynamic Budget Steering: Phase 1 — query Tier 1 first ───────
    // If Tier 1 returns high-relevance results, reduce remaining tier budgets.
    // This saves tokens and improves TTFT on local-context-heavy queries.
    let steeringActive = false;
    let remainingBudget = tokenBudget;
    const allPages: SemanticPage[] = [];
    const emptyTiers: MemoryTier[] = [];
    let tiersQueried = 0;

    if (requestedTiers.includes('main_context') && this.mainContextProvider) {
      try {
        const tier1Pages = await this.queryMainContext(request.query, maxPages);
        tiersQueried++;
        if (tier1Pages.length === 0) {
          emptyTiers.push('main_context');
        } else {
          allPages.push(...tier1Pages);
          this.contextQualityMetrics?.recordPageServed('tier1_main');
          // Check if Tier 1 results warrant steering
          const avgRelevance = tier1Pages.reduce((s, p) => s + p.relevanceScore, 0) / tier1Pages.length;
          const tier1Tokens = tier1Pages.reduce((s, p) => s + p.estimatedTokens, 0);
          if (avgRelevance >= STEERING_HIGH_RELEVANCE_THRESHOLD && tier1Tokens >= tokenBudget * 0.3) {
            steeringActive = true;
            remainingBudget = Math.floor((tokenBudget - tier1Tokens) * STEERING_BUDGET_REDUCTION);
            this.logger?.info('smmu_steering_activated', {
              avg_relevance: avgRelevance,
              tier1_tokens: tier1Tokens,
              remaining_budget: remainingBudget,
              correlation_id: request.correlationId,
            });
          }
        }
      } catch (err) {
        emptyTiers.push('main_context');
        this.logger?.warn('smmu_tier_error', {
          tier: 'main_context',
          error: err instanceof Error ? err.message : String(err),
          correlation_id: request.correlationId,
        });
      }
    } else if (requestedTiers.includes('main_context')) {
      emptyTiers.push('main_context');
    }

    // ── Phase 2 — query remaining tiers in parallel ─────────────────
    const remainingTierPromises: Array<Promise<SemanticPage[]>> = [];
    const remainingTierKeys: MemoryTier[] = [];
    const effectiveMaxPages = steeringActive ? Math.max(2, Math.floor(maxPages * STEERING_BUDGET_REDUCTION)) : maxPages;

    if (requestedTiers.includes('core_recall')) {
      remainingTierKeys.push('core_recall');
      remainingTierPromises.push(this.queryCoreRecall(request.query, effectiveMaxPages, request.correlationId));
    }
    if (requestedTiers.includes('archival')) {
      remainingTierKeys.push('archival');
      remainingTierPromises.push(this.queryArchival(request.query, effectiveMaxPages, request.tenantId));
    }
    if (requestedTiers.includes('knowledge_graph')) {
      remainingTierKeys.push('knowledge_graph');
      remainingTierPromises.push(this.queryKnowledgeGraph(request.query, effectiveMaxPages));
    }

    // FIX: PH-001 — wrap tier queries with timeout to prevent indefinite hangs
    // VEC-004: Incremental Saturation Gates — evaluate after each tier batch
    if (remainingTierPromises.length > 0) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let resolveTimeout: (() => void) | undefined;
      const tierResults = await Promise.race([
        Promise.allSettled(remainingTierPromises),
        new Promise<PromiseSettledResult<SemanticPage[]>[]>((resolve, reject) => {
          resolveTimeout = () => resolve([]);  // settle losing promise to prevent async leak
          timeoutHandle = setTimeout(() => reject(new Error('S-MMU tier query timeout')), TIER_QUERY_TIMEOUT_MS);
        }),
      ]).catch((timeoutErr) => {
        this.logger?.warn('smmu_tier_timeout', {
          timeout_ms: TIER_QUERY_TIMEOUT_MS,
          tiers: remainingTierKeys,
          error: timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr),
          correlation_id: request.correlationId,
        });
        return remainingTierKeys.map<PromiseSettledResult<SemanticPage[]>>((tier) => ({
          status: 'rejected' as const,
          reason: new Error(`Tier ${tier} timed out after ${TIER_QUERY_TIMEOUT_MS}ms`),
        }));
      }).finally(() => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        resolveTimeout?.();  // settle the timeout promise if it lost the race
      });

      const tierLabelMap: Record<string, ContextTierLabel> = {
        core_recall: 'tier2_recall',
        archival: 'tier3_archival',
        knowledge_graph: 'tier4_graph',
      };

      let saturated = false;
      tierResults.forEach((result, idx) => {
        const tier = remainingTierKeys[idx];
        if (result.status === 'fulfilled') {
          tiersQueried++;
          if (result.value.length === 0) {
            emptyTiers.push(tier);
          } else {
            // VEC-004: If already saturated, skip adding pages from lower-priority tiers
            if (saturated) {
              this.logger?.info('smmu_saturation_skipped', {
                tier,
                pages_skipped: result.value.length,
                correlation_id: request.correlationId,
              });
              return;
            }
            allPages.push(...result.value);
            const label = tierLabelMap[tier];
            if (label) {
              this.contextQualityMetrics?.recordPageServed(label);
            }
            // VEC-004: Check incremental saturation after adding this tier's pages
            const currentTokens = allPages.reduce((s, p) => s + p.estimatedTokens, 0);
            const budgetFill = currentTokens / tokenBudget;
            const avgRelevance = allPages.reduce((s, p) => s + p.relevanceScore, 0) / allPages.length;
            if (budgetFill >= SATURATION_THRESHOLD && avgRelevance >= SATURATION_MIN_RELEVANCE) {
              saturated = true;
              this.logger?.info('smmu_saturation_gate', {
                budget_fill: budgetFill,
                avg_relevance: avgRelevance,
                tiers_remaining: remainingTierKeys.slice(idx + 1),
                correlation_id: request.correlationId,
              });
            }
          }
        } else {
          emptyTiers.push(tier);
          this.logger?.warn('smmu_tier_error', {
            tier,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            correlation_id: request.correlationId,
          });
        }
      });
    }

    // Sort by relevance (descending)
    allPages.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // ── Trim to token budget ────────────────────────────────────────
    const budgetedPages: SemanticPage[] = [];
    const droppedPages: SemanticPage[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const page of allPages) {
      if (budgetedPages.length >= maxPages || totalTokens + page.estimatedTokens > tokenBudget) {
        truncated = true;
        droppedPages.push(page);
        continue;
      }
      budgetedPages.push(page);
      totalTokens += page.estimatedTokens;
    }

    // ── VEC-002: Compressive Truncation ─────────────────────────────
    // Instead of silently dropping pages, generate a summary with source
    // references so the model can request targeted follow-up.
    let truncationSummary: TruncationSummary | undefined;
    if (truncated && droppedPages.length > 0) {
      truncationSummary = this.buildTruncationSummary(droppedPages);
    }

    // ── Self-Reflective RAG Judge (REC-089-01) ──────────────────────
    // If IContextRelevanceJudge is available, filter pages by relevance
    // and optionally retry with a rewritten query if results are insufficient.
    let finalPages = budgetedPages;
    if (this.relevanceJudge && finalPages.length > 0) {
      const judgeConfig = this.relevanceJudge.getConfig();
      let currentQuery = request.query;
      let retries = 0;

      while (retries <= judgeConfig.maxRetries) {
        const judgment = await this.relevanceJudge.judge(
          currentQuery,
          finalPages,
          request.correlationId as import('@/ai-types').CorrelationId | undefined,
        );

        this.logger?.info('smmu_relevance_judged', {
          overall_relevance: judgment.overallRelevance,
          is_sufficient: judgment.isSufficient,
          accepted: judgment.acceptedPages.length,
          rejected: judgment.rejectedPages.length,
          strategy: judgment.strategyUsed,
          retry: retries,
          correlation_id: request.correlationId,
        });

        if (judgment.isSufficient || retries >= judgeConfig.maxRetries) {
          // Use accepted pages (preserves order) and recalculate tokens
          finalPages = [...judgment.acceptedPages];
          totalTokens = finalPages.reduce((sum, p) => sum + p.estimatedTokens, 0);
          break;
        }

        // Retry with rewritten query
        currentQuery = judgment.suggestedRewrite
          ?? await this.relevanceJudge.rewriteQuery(
            currentQuery,
            `Low relevance: ${judgment.overallRelevance.toFixed(2)}`,
          );

        // Re-query archival tier with rewritten query (lightweight retry)
        const retryPages = await this.queryArchival(currentQuery, maxPages, request.tenantId);
        if (retryPages.length > 0) {
          retryPages.sort((a, b) => b.relevanceScore - a.relevanceScore);
          finalPages = [];
          totalTokens = 0;
          for (const p of retryPages) {
            if (totalTokens + p.estimatedTokens > tokenBudget) break;
            if (finalPages.length >= maxPages) break;
            finalPages.push(p);
            totalTokens += p.estimatedTokens;
          }
        }
        retries++;
        this.contextQualityMetrics?.recordSelfReflectiveRetry();
      }
    }

    const durationMs = Date.now() - startMs;

    this.logger?.info('smmu_page_retrieved', {
      query_length: request.query.length,
      pages_returned: finalPages.length,
      total_candidates: allPages.length,
      total_tokens: totalTokens,
      token_budget: tokenBudget,
      tiers_queried: tiersQueried,
      truncated,
      steering_active: steeringActive,
      duration_ms: durationMs,
      correlation_id: request.correlationId,
    });

    // ── VEC-001: Head-Tail Repositioning (LITM mitigation) ──────────
    // Transformers exhibit U-shaped attention: head and tail positions receive
    // stronger attention than middle positions (Liu et al. 2023, arXiv:2307.03172).
    // Reorder pages so the highest-relevance items occupy head and tail,
    // pushing lower-relevance items to the (less-attended) middle.
    const reorderedPages = this.headTailReorder(finalPages);

    // ── SPI: Build ContextFrame (Semantic Prefix Isolation) ─────────
    // Prefix = Tier 1 (main_context) pages — immutable per session, cacheable.
    // Dynamic = all other tier pages — vary per query.
    const prefixPages = reorderedPages.filter(p => p.tier === 'main_context');
    const dynamicPages = reorderedPages.filter(p => p.tier !== 'main_context');

    const contextFrame: ContextFrame = {
      prefix: prefixPages,
      dynamic: dynamicPages,
      prefixTokens: prefixPages.reduce((s, p) => s + p.estimatedTokens, 0),
      dynamicTokens: dynamicPages.reduce((s, p) => s + p.estimatedTokens, 0),
    };

    // ── Record metrics ──────────────────────────────────────────────
    this.contextQualityMetrics?.recordRetrievalLatency(durationMs);
    this.contextQualityMetrics?.recordBudgetUtilization(totalTokens, tokenBudget);

    const result: SemanticPagingResult = {
      pages: reorderedPages,
      totalEstimatedTokens: totalTokens,
      tiersQueried,
      emptyTiers,
      durationMs,
      truncated,
      contextFrame,
      truncationSummary,
    };

    // ── Cache the result ────────────────────────────────────────────
    this.cacheResult(cacheKey, result);

    return result;
  }

  async listTiers(): Promise<ReadonlyArray<{ tier: MemoryTier; available: boolean; itemCount: number }>> {
    const tiers: Array<{ tier: MemoryTier; available: boolean; itemCount: number }> = [];

    // Tier 1: Main Context
    if (this.mainContextProvider) {
      try {
        const count = await this.mainContextProvider.getItemCount();
        tiers.push({ tier: 'main_context', available: true, itemCount: count });
      } catch {
        tiers.push({ tier: 'main_context', available: false, itemCount: 0 });
      }
    } else {
      tiers.push({ tier: 'main_context', available: false, itemCount: 0 });
    }

    // Tier 2: Core/Recall (Event Store)
    if (this.eventStore) {
      try {
        const stats = await this.eventStore.getStats();
        tiers.push({ tier: 'core_recall', available: true, itemCount: stats.totalEvents });
      } catch {
        tiers.push({ tier: 'core_recall', available: false, itemCount: 0 });
      }
    } else {
      tiers.push({ tier: 'core_recall', available: false, itemCount: 0 });
    }

    // Tier 3: Archival (Vector Search)
    if (this.archivalProvider) {
      try {
        const count = await this.archivalProvider.getItemCount();
        tiers.push({ tier: 'archival', available: true, itemCount: count });
      } catch {
        tiers.push({ tier: 'archival', available: false, itemCount: 0 });
      }
    } else {
      tiers.push({ tier: 'archival', available: false, itemCount: 0 });
    }

    // Tier 4: Knowledge Graph (GraphRAG, Phase 5.5)
    if (this.graphContextProvider) {
      try {
        const count = await this.graphContextProvider.getNodeCount();
        tiers.push({ tier: 'knowledge_graph', available: true, itemCount: count });
      } catch {
        tiers.push({ tier: 'knowledge_graph', available: false, itemCount: 0 });
      }
    } else {
      tiers.push({ tier: 'knowledge_graph', available: false, itemCount: 0 });
    }

    return tiers;
  }

  // ── Tier Query Implementations ────────────────────────────────────

  private async queryMainContext(query: string, maxResults: number): Promise<SemanticPage[]> {
    if (!this.mainContextProvider) return [];

    const results = await this.mainContextProvider.search(query, maxResults);
    return results.map((r, idx) => ({
      pageId: `main_${idx}_${Date.now()}`,
      tier: 'main_context',
      relevanceScore: r.score,
      content: r.content,
      source: r.source,
      estimatedTokens: r.tokens || this.estimateTokens(r.content),
      updatedAt: new Date().toISOString(),
    }));
  }

  private async queryCoreRecall(
    query: string,
    maxResults: number,
    correlationId?: string,
  ): Promise<SemanticPage[]> {
    if (!this.eventStore) return [];

    // Strategy: search events by type keywords extracted from query.
    // For Horizon 2, use getEventsByType with keyword partial matching.
    // In Horizon 3, this will be replaced by vector-indexed event search.
    const keywords = this.extractKeywords(query);
    const events: DomainEvent[] = [];

    for (const keyword of keywords.slice(0, 3)) {
      try {
        const typeEvents = await this.eventStore.getEventsByType(keyword);
        events.push(...typeEvents);
      } catch {
        // Best-effort: some event types may not exist
      }
    }

    // Fallback: if no keyword match, try recent events by correlation
    if (events.length === 0 && correlationId) {
      try {
        const corrEvents = await this.eventStore.getEventsByCorrelationId(correlationId);
        events.push(...corrEvents);
      } catch {
        // Fallback failed — no events from core_recall
      }
    }

    // Deduplicate by eventId
    const uniqueEvents = new Map<string, DomainEvent>();
    for (const event of events) {
      if (!uniqueEvents.has(event.eventId)) {
        uniqueEvents.set(event.eventId, event);
      }
    }

    // Convert to SemanticPage, score by recency
    const nowMs = Date.now();
    const pages: SemanticPage[] = [];
    for (const [, event] of uniqueEvents) {
      if (pages.length >= maxResults) break;
      const ageMs = nowMs - new Date(event.timestamp).getTime();
      const recencyScore = Math.max(0, 1 - ageMs / (7 * 24 * 60 * 60 * 1000)); // decay over 7 days
      const content = JSON.stringify(event.payload ?? {});
      pages.push({
        pageId: `recall_${event.eventId}`,
        tier: 'core_recall',
        relevanceScore: recencyScore * 0.8 + 0.1, // base relevance + recency
        content,
        source: `event:${event.type}:${event.eventId}`,
        estimatedTokens: this.estimateTokens(content),
        updatedAt: new Date(event.timestamp).toISOString(),
        metadata: event.metadata,
      });
    }

    return pages;
  }

  private async queryArchival(
    query: string,
    maxResults: number,
    tenantId?: string,
  ): Promise<SemanticPage[]> {
    // REC-089-02: Prefer hybrid BM25+vector retrieval when available
    if (this.hybridRetrieval && this.hybridRetrievalEnabled) {
      const results = await this.hybridRetrieval.search(query, maxResults);
      for (const r of results) {
        if (r.method === 'bm25') this.contextQualityMetrics?.recordHybridHit('bm25');
        else if (r.method === 'vector') this.contextQualityMetrics?.recordHybridHit('vector');
      }
      return results.map((r, idx) => ({
        pageId: `archival_hybrid_${idx}_${Date.now()}`,
        tier: 'archival',
        relevanceScore: r.fusedScore,
        content: r.content,
        source: r.source,
        estimatedTokens: r.tokens || this.estimateTokens(r.content),
        updatedAt: r.updatedAt,
      }));
    }

    if (this.hybridRetrieval && !this.hybridRetrievalEnabled) {
      this.logger?.info('smmu_hybrid_retrieval_disabled', {
        reason: 'config_gate',
      });
    }

    if (!this.archivalProvider) return [];

    const results = await this.archivalProvider.search(query, maxResults, tenantId);
    return results.map((r, idx) => ({
      pageId: `archival_${idx}_${Date.now()}`,
      tier: 'archival',
      relevanceScore: r.score,
      content: r.content,
      source: r.source,
      estimatedTokens: r.tokens || this.estimateTokens(r.content),
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Tier 4: Knowledge Graph — AST-driven structural traversal (Phase 5.5)
   *
   * Queries the KnowledgeGraphEngine for entity relationships and converts
   * the graph subgraph (nodes + edges) into SemanticPage[] format.
   * Deterministic retrieval: high base relevance (0.92) since structural
   * relationships are exact, not probabilistic.
   */
  private async queryKnowledgeGraph(
    query: string,
    maxResults: number,
  ): Promise<SemanticPage[]> {
    if (!this.graphContextProvider) return [];

    const results = await this.graphContextProvider.search(query, maxResults);
    return results.map((r, idx) => ({
      pageId: `graph_${idx}_${Date.now()}`,
      tier: 'knowledge_graph',
      relevanceScore: r.score,
      content: r.content,
      source: r.source,
      estimatedTokens: r.tokens || this.estimateTokens(r.content),
      updatedAt: new Date().toISOString(),
    }));
  }

  // ── Semantic Cache ─────────────────────────────────────────────────

  /**
   * Normalize query to a cache key for semantic deduplication.
   *
   * Steps:
   * 1. Lowercase
   * 2. Remove non-alphanumeric (keep Unicode letters and digits)
   * 3. Split into tokens, remove stop words and short tokens (≤2 chars)
   * 4. Sort alphabetically
   * 5. Join with space
   *
   * "How does the DI container work?" → "container work"
   * "What is Dependency Injection?"   → "dependency injection"
   * "How does DI work?"               → "di work"
   */
  private normalizeQuery(query: string): string {
    const normalized = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      .sort()
      .join(' ');

    // Fallback: if all words were stop-words or too short,
    // use the trimmed lowercase query to avoid empty-key collisions.
    return normalized || query.toLowerCase().trim();
  }

  /**
   * Retrieve a cached result if key exists, TTL is valid, and budget matches.
   * Increments hit count on successful retrieval.
   */
  private getCachedResult(
    cacheKey: string,
    tokenBudget: number,
    maxPages: number,
  ): CacheEntry | undefined {
    const entry = this.queryCache.get(cacheKey);
    if (!entry) return undefined;

    // Reject stale entries written before the last invalidation
    if (entry.generation < this.cacheGeneration) {
      this.queryCache.delete(cacheKey);
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.queryCache.delete(cacheKey);
      return undefined;
    }

    // Verify cached result fits the requested budget
    if (
      entry.result.totalEstimatedTokens > tokenBudget ||
      entry.result.pages.length > maxPages
    ) {
      return undefined;
    }

    entry.hitCount++;
    return entry;
  }

  /**
   * Store result in cache. Evicts oldest entry if cache exceeds MAX_CACHE_SIZE.
   */
  private cacheResult(cacheKey: string, result: SemanticPagingResult): void {
    // LRU eviction: remove oldest entry when at capacity
    if (this.queryCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.queryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.queryCache.delete(oldestKey);
      }
    }

    this.queryCache.set(cacheKey, {
      result,
      timestamp: Date.now(),
      hitCount: 0,
      generation: this.cacheGeneration,
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────

  private estimateTokens(text: string): number {
    if (this.tokenBudgetManager) {
      return this.tokenBudgetManager.countTokens(text);
    }
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Compute a model-aware default paging budget.
   * GAP-001 FIX: When tokenBudgetManager is available, delegates to it for accurate
   * model context window lookup. Falls back to static getModelContextWindow() otherwise.
   * Allocates a proportional fraction of the model's context window for S-MMU pages.
   */
  private computeModelAwareBudget(model?: string): number | undefined {
    if (!model && !this.tokenBudgetManager) return undefined;

    // Use model or sensible default when budget manager is available
    const effectiveModel = model ?? 'gpt-4';
    const contextWindow = getModelContextWindow(effectiveModel);

    if (contextWindow <= 4096) return undefined;
    if (contextWindow <= 8192) return Math.floor(contextWindow * 0.25);
    if (contextWindow <= 32768) return Math.min(8192, Math.floor(contextWindow * 0.15));
    if (contextWindow <= 128000) return Math.min(16384, Math.floor(contextWindow * 0.10));
    return Math.min(32768, Math.floor(contextWindow * 0.08));
  }

  // ── VEC Mitigations ─────────────────────────────────────────────────

  /**
   * VEC-003: Build a cache key that combines semantic deduplication (sorted tokens)
   * with an intent hash (word-order-sensitive hash) to prevent collisions between
   * queries like "delete user" vs "user delete".
   *
   * @pattern Intent-Aware Cache Key — SOTA 2026 Context Engineering
   */
  private buildCacheKey(query: string): string {
    const semanticKey = this.normalizeQuery(query);
    // DJB2-style hash of original word order (after lowercase + stop-word removal)
    const intentWords = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    let hash = 5381;
    for (const w of intentWords) {
      for (let i = 0; i < w.length; i++) {
        hash = ((hash << 5) + hash + w.charCodeAt(i)) | 0;
      }
    }
    return `${semanticKey}|${(hash >>> 0).toString(36)}`;
  }

  /**
   * VEC-001: Head-Tail Repositioning for LITM mitigation.
   *
   * Transformer attention follows a U-shaped curve: positions at the head
   * and tail of the context receive stronger attention than middle positions
   * (Liu et al. 2023, arXiv:2307.03172 "Lost in the Middle").
   *
   * This method reorders relevance-sorted pages using a head-tail interleave:
   * Input (by rank): [1, 2, 3, 4, 5, 6]
   * Output (by position): [1, 3, 5, 6, 4, 2]
   *
   * The highest-ranked items go to head and tail positions; lower-ranked
   * items are pushed to the middle where transformer attention is weakest,
   * creating optimal alignment between relevance and attention distribution.
   *
   * @pattern Head-Tail Repositioning — LITM Mitigation
   * @see Liu et al. (2023) arXiv:2307.03172 "Lost in the Middle"
   */
  private headTailReorder(pages: SemanticPage[]): SemanticPage[] {
    if (pages.length <= 2) return [...pages];

    // Pages are already sorted by relevance (desc).
    // Place odd-indexed items at the head, even-indexed at the tail (reversed).
    const head: SemanticPage[] = [];
    const tail: SemanticPage[] = [];
    for (let i = 0; i < pages.length; i++) {
      if (i % 2 === 0) {
        head.push(pages[i]);
      } else {
        tail.unshift(pages[i]);
      }
    }
    return [...head, ...tail];
  }

  /**
   * VEC-002: Build a compressive truncation summary from dropped pages.
   *
   * Instead of silently discarding pages that exceed the token budget,
   * generates a concise summary preserving source references. The model
   * can use this to request targeted follow-up retrieval.
   *
   * @pattern Compressive Truncation — SOTA 2026 Context Engineering
   * @see Munkhdalai et al. (2024) arXiv:2404.07143 "Infini-attention"
   */
  private buildTruncationSummary(droppedPages: readonly SemanticPage[]): TruncationSummary {
    const droppedTokens = droppedPages.reduce((s, p) => s + p.estimatedTokens, 0);
    const sources = droppedPages.map(p => p.source);
    const uniqueSources = [...new Set(sources)];

    // Build a deterministic, compact summary of what was truncated
    const tierCounts = new Map<string, number>();
    for (const p of droppedPages) {
      tierCounts.set(p.tier, (tierCounts.get(p.tier) ?? 0) + 1);
    }
    const tierBreakdown = [...tierCounts.entries()]
      .map(([tier, count]) => `${tier}: ${count}`)
      .join(', ');

    const topRelevance = droppedPages.length > 0
      ? droppedPages.reduce((best, p) => Math.max(best, p.relevanceScore), 0)
      : 0;

    const summary = [
      `Truncated ${droppedPages.length} page(s) (${droppedTokens} tokens) due to budget limit.`,
      `Tiers: ${tierBreakdown}.`,
      `Best relevance among dropped: ${topRelevance.toFixed(2)}.`,
      `Sources: ${uniqueSources.slice(0, 5).join(', ')}${uniqueSources.length > 5 ? ` (+${uniqueSources.length - 5} more)` : ''}.`,
    ].join(' ');

    return { summary, droppedCount: droppedPages.length, droppedTokens, sources: uniqueSources };
  }

  /**
   * Extract potential event type keywords from a natural language query.
   * Simple heuristic: split on spaces, keep tokens > 3 chars, lowercase with dots.
   */
  private extractKeywords(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[^a-z0-9.\s_-]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);
  }
}
