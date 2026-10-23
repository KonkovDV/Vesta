/**
 * Domain port: Query Classification Verifier (LLM shadow consensus).
 *
 * Provides LLM-backed verification of heuristic query classification results.
 * When the lightweight heuristic classifier (classifyQuery) produces uncertain
 * results, this port enables shadow verification using a language model to
 * improve routing accuracy for Agentic GraphRAG pipelines.
 *
 * Design rationale:
 * - Heuristic classifier runs on every query (zero latency)
 * - LLM verifier only runs when heuristic confidence is low (cost-efficient)
 * - Shadow mode: LLM result is logged but heuristic result is used (for calibration)
 * - Override mode: LLM result overrides heuristic when confidence gap is significant
 *
 * Academic foundation:
 * - Reciprocal Rank Fusion (Cormack et al., 2009)
 * - Agentic RAG patterns (Microsoft GraphRAG, 2024)
 * - Query intent classification (Broder, 2002 — navigational/informational/transactional taxonomy)
 * - Multi-strategy retrieval routing (RAPTOR, Sarthi et al., 2024)
 *
 * @see src/application/memory/rrf-hybrid-search.service.ts — classifyQuery heuristic
 * @see src/domain/ai/IModelRouter.ts — LLM model selection for verification
 *
 * CC-ID: (companion to ICodeGraphStore, CC-014 scope)
 * Layer: Domain
 * DI Token: DI_TOKENS.IQueryClassificationVerifier
 */

import type { CorrelationId } from '@/core/types/branded';

/**
 * Search strategy classification.
 * Must stay in sync with QueryClassification in rrf-hybrid-search.service.ts.
 */
export type VerifiedQueryClassification = 'structural' | 'semantic' | 'keyword' | 'hybrid';

/** Source of the classification decision. */
export type ClassificationSource = 'heuristic' | 'llm' | 'shadow-llm';

/** Result of query classification verification. */
export interface QueryClassificationResult {
  /** Final classification (either heuristic or LLM-verified). */
  readonly classification: VerifiedQueryClassification;
  /** Confidence score [0, 1] — 1.0 = fully certain. */
  readonly confidence: number;
  /** Source of the decision. */
  readonly source: ClassificationSource;
  /** Original heuristic classification (for comparison/logging). */
  readonly heuristicClassification: VerifiedQueryClassification;
  /** Whether LLM agreed with heuristic (null if LLM was not called). */
  readonly llmAgreed: boolean | null;
  /** Duration of verification in ms (0 if heuristic-only). */
  readonly durationMs: number;
}

/** Input for query classification verification. */
export interface QueryVerificationInput {
  /** The user query to classify. */
  readonly query: string;
  /** Heuristic classification result from classifyQuery(). */
  readonly heuristicResult: VerifiedQueryClassification;
  /** Whether to force LLM verification regardless of confidence. */
  readonly forceVerification?: boolean;
  /** Correlation ID for tracing. */
  readonly correlationId: CorrelationId;
}

/**
 * Query Classification Verifier — LLM shadow consensus for search routing.
 *
 * Verifies heuristic query classifications using an LLM model when confidence
 * is below a configurable threshold, improving search accuracy for ambiguous queries.
 */
export interface IQueryClassificationVerifier {
  /**
   * Verify a heuristic query classification using LLM shadow consensus.
   *
   * When the heuristic classification has low confidence (e.g., query matches
   * no structural/semantic patterns), the LLM is consulted to provide a more
   * accurate classification.
   *
   * @param input - Query and heuristic classification to verify
   * @returns Verified classification result with confidence and source metadata
   */
  verify(input: QueryVerificationInput): Promise<QueryClassificationResult>;
}
