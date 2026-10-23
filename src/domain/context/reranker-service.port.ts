/**
 * IRerankerService — Domain port for semantic reranking
 * @layer Domain
 *
 * Implements two-stage retrieval: first retrieve candidates, then rerank
 * by deeper relevance analysis. Based on ColBERTv2 late interaction
 * and cross-encoder patterns.
 *
 * @see arXiv:2112.01488 — ColBERTv2: Effective and Efficient Retrieval via Lightweight Late Interaction
 * @see arXiv:2004.12832 — ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction
 */

// ─── Strategy Types ──────────────────────────────────────────────────

export type RerankingStrategy =
  | 'cross_encoder'       // Full cross-attention (highest quality, slower)
  | 'late_interaction'    // ColBERTv2 MaxSim (balanced quality/speed)
  | 'score_fusion';       // Reciprocal rank fusion of multiple signals

// ─── Configuration ───────────────────────────────────────────────────

export interface RerankingConfig {
  readonly strategy: RerankingStrategy;
  readonly maxCandidates: number;    // Max candidates to rerank (default: 20)
  readonly minScore: number;         // Filter threshold (default: 0.3)
  readonly normalizeScores: boolean; // Normalize to [0,1] range
}

export const DEFAULT_RERANKING_CONFIG: RerankingConfig = {
  strategy: 'cross_encoder',
  maxCandidates: 20,
  minScore: 0.3,
  normalizeScores: true,
};

// ─── Result Types ────────────────────────────────────────────────────

export interface ScoredDocument {
  /** Original document identifier */
  readonly documentId: string;
  /** Document content */
  readonly content: string;
  /** Score before reranking */
  readonly originalScore: number;
  /** Score after reranking */
  readonly rerankScore: number;
  /** Source/origin of this document */
  readonly source?: string;
  /** Estimated token count */
  readonly estimatedTokens: number;
}

export interface RerankingResult {
  /** Reranked & filtered documents (descending by rerankScore) */
  readonly documents: readonly ScoredDocument[];
  /** Number of documents removed by minScore filter */
  readonly filteredCount: number;
  /** Which strategy was actually used */
  readonly strategyUsed: RerankingStrategy;
  /** Time taken in ms */
  readonly durationMs: number;
}

// ─── Port Interface ──────────────────────────────────────────────────

export interface IRerankerService {
  /**
   * Rerank a set of candidate documents against a query.
   * Returns documents sorted by relevance (descending),
   * with those below minScore filtered out.
   */
  rerank(
    query: string,
    documents: readonly ScoredDocument[],
    config?: Partial<RerankingConfig>,
  ): Promise<RerankingResult>;

  /** Current effective configuration */
  getConfig(): RerankingConfig;

  /** Whether the reranking backend is available */
  isAvailable(): Promise<boolean>;
}
