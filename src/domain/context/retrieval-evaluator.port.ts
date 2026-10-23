/**
 * IRetrievalEvaluator — Domain port for retrieval quality evaluation
 * @layer Domain
 *
 * Evaluates whether retrieved documents are relevant to a query and
 * recommends corrective actions when retrieval quality is insufficient.
 * Based on CRAG (Corrective Retrieval-Augmented Generation).
 *
 * @see arXiv:2401.15884 — Corrective Retrieval Augmented Generation
 * @see arXiv:2310.11511 — Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection
 */

import type { ScoredDocument } from './reranker-service.port';

// ─── Confidence & Action Types ───────────────────────────────────────

/** Three-level confidence as defined in CRAG paper */
export type RetrievalConfidenceLevel = 'correct' | 'ambiguous' | 'incorrect';

/** Corrective actions triggered by confidence level */
export type CorrectiveAction =
  | 'proceed'          // CORRECT: use retrieved docs as-is
  | 'augment'          // AMBIGUOUS: augment with additional retrieval
  | 'decompose'        // AMBIGUOUS: split query into sub-queries
  | 'rewrite_query'    // INCORRECT: reformulate query
  | 'refuse';          // INCORRECT: not enough information

// ─── Configuration ───────────────────────────────────────────────────

export interface RetrievalEvaluatorConfig {
  /** Score threshold above which retrieval is "correct" (default: 0.7) */
  readonly correctThreshold: number;
  /** Score threshold above which retrieval is "ambiguous" (default: 0.4) */
  readonly ambiguousThreshold: number;
  /** Max docs to evaluate (default: 30) */
  readonly maxDocuments: number;
  /** Min relevant docs to consider result adequate (default: 1) */
  readonly minRelevantDocs: number;
  /** Enable query rewrite suggestions */
  readonly enableRewrite: boolean;
  /** Enable query decomposition */
  readonly enableDecompose: boolean;
}

export const DEFAULT_EVALUATOR_CONFIG: RetrievalEvaluatorConfig = {
  correctThreshold: 0.7,
  ambiguousThreshold: 0.4,
  maxDocuments: 30,
  minRelevantDocs: 1,
  enableRewrite: true,
  enableDecompose: true,
};

// ─── Per-Document Eval ───────────────────────────────────────────────

export interface DocumentEvaluation {
  readonly document: ScoredDocument;
  /** Relevance score (0–1) assigned by evaluator */
  readonly relevanceScore: number;
  /** Whether this doc is considered relevant */
  readonly isRelevant: boolean;
  /** Key information extracted (for decompose-recompose) */
  readonly keyInfo?: string;
  /** Human-readable explanation */
  readonly explanation?: string;
}

// ─── Result ──────────────────────────────────────────────────────────

export interface RetrievalEvaluationResult {
  readonly confidenceLevel: RetrievalConfidenceLevel;
  readonly confidenceScore: number;
  readonly recommendedAction: CorrectiveAction;
  readonly documentEvaluations: readonly DocumentEvaluation[];
  readonly relevantDocuments: readonly ScoredDocument[];
  readonly irrelevantDocuments: readonly ScoredDocument[];
  readonly durationMs: number;
  /** Suggested rewritten query (when action = 'rewrite_query') */
  readonly suggestedRewrite?: string;
  /** Sub-queries (when action = 'decompose') */
  readonly subQueries?: readonly string[];
}

// ─── Port Interface ──────────────────────────────────────────────────

export interface IRetrievalEvaluator {
  /**
   * Evaluate retrieval quality and recommend corrective action.
   * Returns confidence level + per-document evaluations.
   */
  evaluate(
    query: string,
    documents: readonly ScoredDocument[],
    config?: Partial<RetrievalEvaluatorConfig>,
  ): Promise<RetrievalEvaluationResult>;

  /**
   * CRAG decompose-then-recompose: extract key info per document,
   * filter irrelevant sentences, return condensed documents.
   */
  decomposeRecompose(
    query: string,
    documents: readonly ScoredDocument[],
  ): Promise<readonly ScoredDocument[]>;

  /** Current effective configuration */
  getConfig(): RetrievalEvaluatorConfig;
}
