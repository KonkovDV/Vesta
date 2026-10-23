/**
 * IHybridRetrievalService — Domain Port for BM25 + Vector Hybrid Retrieval
 *
 * Combines lexical (BM25) and semantic (vector embedding) search with
 * Reciprocal Rank Fusion (RRF) for optimal precision-recall in S-MMU Tier 3.
 *
 * Why hybrid matters:
 *   - Vector search excels at semantic similarity ("what is event sourcing?")
 *   - BM25 excels at exact keyword matching ("IEventStore", "DI_TOKENS")
 *   - Cross-encoder re-ranking combines both signals for final ordering
 *
 * Academic References:
 *   - Robertson & Zaragoza (2009) "The Probabilistic Relevance Framework: BM25 and Beyond"
 *   - Cormack et al. (2009) "Reciprocal Rank Fusion outperforms Condorcet and individual methods"
 *   - Anthropic (2025) "Hybrid retrieval combines BM25 keyword match with dense embedding
 *     similarity, followed by cross-encoder re-ranking"
 *   - Nogueira & Cho (2019) "Passage Re-ranking with BERT" (cross-encoder foundation)
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @horizon Horizon 2 — Context Engineering: Hybrid Retrieval
 * @pattern REC-089-02 Hybrid BM25+Vector Retrieval
 */

import type { CorrelationId } from '@/ai-types';

// ── Retrieval Method ──────────────────────────────────────────────

/** Which retrieval method produced a result. */
export type RetrievalMethod = 'bm25' | 'vector' | 'hybrid';

/** Strategy for fusing BM25 and vector scores. */
export type FusionStrategy =
  | 'reciprocal_rank_fusion'   // RRF: 1/(k + rank), k=60
  | 'weighted_sum'             // bm25Weight * bm25 + vectorWeight * vector
  | 'cross_encoder';           // Neural cross-encoder re-ranking

// ── Search Result ─────────────────────────────────────────────────

/** A single hybrid search result with multi-signal scores. */
export interface HybridSearchResult {
  /** Document content. */
  readonly content: string;
  /** Source reference (file path, chunk ID, etc.). */
  readonly source: string;
  /** BM25 lexical score (undefined if vector-only). */
  readonly bm25Score?: number;
  /** Vector cosine similarity (0–1, undefined if BM25-only). */
  readonly vectorScore?: number;
  /** Fused score after RRF or weighted combination (0–1). */
  readonly fusedScore: number;
  /** Which method produced this result. */
  readonly method: RetrievalMethod;
  /** Estimated token count. */
  readonly tokens: number;
  /** ISO timestamp of source update. */
  readonly updatedAt: string;
}

// ── Configuration ─────────────────────────────────────────────────

/** Configuration for hybrid retrieval. */
export interface HybridRetrievalConfig {
  /** Weight for BM25 signal in fusion (0.0–1.0). */
  readonly bm25Weight: number;
  /** Weight for vector signal in fusion (0.0–1.0). */
  readonly vectorWeight: number;
  /** Fusion strategy. */
  readonly fusionStrategy: FusionStrategy;
  /** Maximum results to return. */
  readonly maxResults: number;
  /** Minimum fused score threshold. */
  readonly minScore: number;
}

// ── Port Interface ────────────────────────────────────────────────

/**
 * IHybridRetrievalService — combines BM25 lexical search with vector
 * semantic search and fuses results using RRF or cross-encoder re-ranking.
 *
 * Replaces pure-vector search in VectorArchivalProvider for Tier 3.
 */
export interface IHybridRetrievalService {
  /**
   * Perform hybrid search combining BM25 and vector retrieval.
   *
   * @param query — natural language search query
   * @param maxResults — maximum results to return
   * @param correlationId — for observability
   * @returns Fused and ranked results
   */
  search(
    query: string,
    maxResults: number,
    correlationId?: CorrelationId,
  ): Promise<readonly HybridSearchResult[]>;

  /**
   * Perform BM25-only search (lexical keyword matching).
   */
  searchBm25(
    query: string,
    maxResults: number,
  ): Promise<readonly HybridSearchResult[]>;

  /**
   * Perform vector-only search (semantic embedding similarity).
   */
  searchVector(
    query: string,
    maxResults: number,
  ): Promise<readonly HybridSearchResult[]>;

  /**
   * Get current retrieval configuration.
   */
  getConfig(): HybridRetrievalConfig;

  /**
   * Get index statistics (document count, index health).
   */
  getIndexStats(): Promise<{
    totalDocuments: number;
    bm25Indexed: number;
    vectorIndexed: number;
  }>;
}
