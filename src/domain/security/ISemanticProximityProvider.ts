/**
 * ISemanticProximityProvider — Domain port for vector-based file similarity.
 *
 * Augments CC-029 IntentGraphAnalyzer's structural import-graph proximity with
 * semantic proximity from the S-MMU Tier-3 Archival Vector Storage. While import
 * chains capture syntactic dependencies, semantic vectors capture conceptual
 * relatedness — files that never import each other may still be semantically close
 * (e.g., two different event handlers for the same domain aggregate).
 *
 * Design Rationale:
 *   - Optional injection: IntentGraphAnalyzer works without vectors (falls back to
 *     directory distance), but gains precision when semantic vectors are available
 *   - Similarity score [0, 1]: 1.0 = identical semantic content, 0.0 = completely unrelated
 *   - Batch support: graph initialization may query many file pairs at once
 *
 * Integration Points:
 *   - IIntentGraphAnalyzer (CC-029) — primary consumer for proximity blending
 *   - S-MMU Tier-3 (Vector Archival Storage) — source of embedding vectors
 *   - KnowledgeGraphProvider (V3) — structural graph complements semantic vectors
 *
 * Academic Basis:
 *   - Epistemic Context Learning (arXiv:2601.21742, Jan 2026) — calibrated trust via embeddings
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M4 Enhanced Data Registry
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-029+ Vector-Augmented Graph (PUA v5.2 → v5.3 S-MMU integration)
 * @see src/domain/security/IIntentGraphAnalyzer.ts — CC-029 consumer
 * @sota-stub No vector storage integration yet — port defines the contract
 */

// ── Types ──────────────────────────────────────────────────────────

/** Similarity result between two files. */
export interface SemanticSimilarityResult {
  /** First file path. */
  readonly fileA: string;
  /** Second file path. */
  readonly fileB: string;
  /** Cosine similarity score [0, 1]. */
  readonly similarity: number;
  /** Whether embeddings were available for both files. */
  readonly embeddingsAvailable: boolean;
  /** Computation timestamp (ISO 8601). */
  readonly computedAt: string;
}

/** Batch similarity query result. */
export interface BatchSimilarityResult {
  /** Individual similarity results. */
  readonly results: readonly SemanticSimilarityResult[];
  /** Number of files with available embeddings. */
  readonly embeddingsCoverage: number;
  /** Total files queried. */
  readonly totalQueried: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Semantic Proximity Provider — vector-based file similarity for graph augmentation.
 *
 * @sota-stub No S-MMU Tier-3 integration yet — port defines the contract
 *   for future vector storage integration.
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ISemanticProximityProvider {
  /** Get semantic similarity between two files (cosine similarity [0, 1]). */
  getSimilarity(fileA: string, fileB: string): Promise<SemanticSimilarityResult>;

  /** Batch similarity: one source file against many targets. */
  getBatchSimilarity(
    sourceFile: string,
    targetFiles: readonly string[],
  ): Promise<BatchSimilarityResult>;

  /** Check if embeddings are available for a file. */
  hasEmbedding(filePath: string): boolean;
}
