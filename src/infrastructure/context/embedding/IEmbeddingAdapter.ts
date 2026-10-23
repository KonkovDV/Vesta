/**
 * IEmbeddingAdapter — Port for embedding providers.
 *
 * Abstracts text vectorization so different backends (OpenAI, local model, TF-IDF)
 * can be used interchangeably for the VectorArchivalProvider.
 *
 * @layer Infrastructure (Context / Embedding)
 * @since v2.9.0 — Phase 2 (V3 Context Engineering)
 * @see PLANS/DOCS_AUDIT_2026/PHASE_2_DENSE_EMBEDDINGS.md
 */

/**
 * Adapter for generating text embeddings (dense vectors).
 *
 * Implementations:
 * - OpenAIEmbeddingAdapter: OpenAI text-embedding-3-small (1536 dims, best accuracy)
 * - LocalEmbeddingAdapter: Fallback BM25-style sparse hashing (no API needed)
 */
export interface IEmbeddingAdapter {
  /**
   * Embed one or more texts into dense vectors.
   *
   * @param texts - Array of text strings to embed
   * @returns Array of embedding vectors (same length as input)
   */
  embed(texts: string[]): Promise<number[][]>;

  /** Embedding dimensions (e.g. 1536 for text-embedding-3-small) */
  readonly dimensions: number;

  /** Model identifier string */
  readonly model: string;
}
