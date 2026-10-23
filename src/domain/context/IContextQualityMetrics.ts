/**
 * IContextQualityMetrics — Domain Port for Context Engineering Observability
 *
 * Tracks operational metrics across the entire context pipeline:
 * S-MMU retrieval, caching, prefetch accuracy, compaction ratios,
 * and token budget utilization.
 *
 * Metrics enable answering:
 *   - "What % of queries are served from Tier 1 vs Tier 3?"
 *   - "What is the average cache hit rate?"
 *   - "How accurate is Markov prefetch?"
 *   - "What is the compaction ratio per strategy?"
 *
 * Academic References:
 *   - FinOps for AI (2026): Token-level cost attribution per context tier
 *   - Google (2025): SRE for AI systems — context retrieval SLIs/SLOs
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern REC-089-05 Context Quality Metrics
 */

// ── Tier Labels ───────────────────────────────────────────────────

/** Labels for context tiers in metrics. */
export type ContextTierLabel =
  | 'tier1_main'
  | 'tier2_recall'
  | 'tier3_archival'
  | 'tier4_graph';

// ── Snapshot ──────────────────────────────────────────────────────

/** Point-in-time snapshot of context quality metrics. */
export interface ContextQualitySnapshot {
  /** Pages served from each tier since last reset. */
  readonly pagesServedByTier: Readonly<Record<ContextTierLabel, number>>;
  /** Cache hit rate (0.0–1.0). */
  readonly cacheHitRate: number;
  /** Prefetch accuracy: % of prefetched items actually used (0.0–1.0). */
  readonly prefetchAccuracy: number;
  /** Compaction ratio: compacted / original tokens (0.0–1.0). */
  readonly compactionRatio: number;
  /** Token budget utilization: used / allocated (0.0–1.0). */
  readonly tokenBudgetUtilization: number;
  /** Average retrieval latency in milliseconds. */
  readonly avgRetrievalLatencyMs: number;
  /** Total queries since last reset. */
  readonly totalQueries: number;
  /** Self-reflective RAG retry count. */
  readonly selfReflectiveRetries: number;
  /** BM25 hits in hybrid retrieval. */
  readonly hybridRetrievalBm25Hits: number;
  /** Vector hits in hybrid retrieval. */
  readonly hybridRetrievalVectorHits: number;
  /** ISO timestamp of snapshot. */
  readonly timestamp: string;
}

// ── Port Interface ──────────────────────────────────────────────

/**
 * IContextQualityMetrics — collects and exposes context pipeline metrics.
 *
 * Each method records a single metric event. Snapshot aggregates all.
 * Implementations may integrate with Prometheus, StatsD, or in-memory.
 */
export interface IContextQualityMetrics {
  /** Record a page served from a specific tier. */
  recordPageServed(tier: ContextTierLabel): void;

  /** Record a cache hit or miss. */
  recordCacheAccess(hit: boolean): void;

  /** Record a prefetch result (used or unused). */
  recordPrefetchResult(used: boolean): void;

  /** Record a compaction operation. */
  recordCompaction(originalTokens: number, compactedTokens: number): void;

  /** Record token budget utilization. */
  recordBudgetUtilization(usedTokens: number, allocatedTokens: number): void;

  /** Record retrieval latency. */
  recordRetrievalLatency(latencyMs: number): void;

  /** Record a self-reflective RAG retry. */
  recordSelfReflectiveRetry(): void;

  /** Record a hybrid retrieval method hit. */
  recordHybridHit(method: 'bm25' | 'vector'): void;

  /** Get current metrics snapshot. */
  getSnapshot(): ContextQualitySnapshot;

  /** Reset all counters. */
  reset(): void;
}
