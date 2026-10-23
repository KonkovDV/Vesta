/**
 * IEventVectorizer — Domain port for event vectorization.
 * Layer: Domain (Memory)
 *
 * Abstracts embedding generation so Domain/Application layers
 * remain decoupled from specific ML frameworks.
 *
 * @since v2.9.0 — Этап 6 (Semantic Event Sourcing)
 * @see PLANS/05_NEXT_PHASES/PROMPT_PHASE_4_SEMANTIC.md
 */

/**
 * Result of a semantic event search query.
 */
export interface SemanticEventResult {
  /** Event ID */
  readonly eventId: string;
  /** Event type (canonical) */
  readonly type: string;
  /** Event payload */
  readonly payload: Record<string, unknown>;
  /** Event timestamp */
  readonly timestamp: Date;
  /** Aggregate ID */
  readonly aggregateId: string;
  /** Cosine similarity score (0..1, higher = more similar) */
  readonly similarity: number;
}

/**
 * Embedding update entry for batch event vectorization.
 */
export interface EventEmbeddingUpdate {
  /** Event ID to update */
  readonly eventId: string;
  /** Computed embedding vector */
  readonly embedding: number[];
}

/**
 * Port for vectorizing event text into dense embeddings.
 *
 * Domain/Application depends on this abstraction.
 * Infrastructure provides the concrete implementation
 * (e.g. Hugging Face Transformers.js with ONNX Runtime).
 */
export interface IEventVectorizer {
  /**
   * Initialize the vectorizer (load model, warm up).
   * Must be called before vectorize/vectorizeBatch.
   */
  initialize(): Promise<void>;

  /**
   * Vectorize a single text into a dense embedding.
   *
   * @param text - Input text (e.g. serialized event)
   * @returns Dense float vector of configured dimension
   */
  vectorize(text: string): Promise<number[]>;

  /**
   * Vectorize multiple texts in a single batch.
   *
   * @param texts - Array of input texts
   * @returns Array of dense float vectors (same length as input)
   */
  vectorizeBatch(texts: string[]): Promise<number[][]>;

  /** Embedding dimension (e.g. 384 for all-MiniLM-L6-v2) */
  readonly dimensions: number;

  /** Whether the vectorizer has been initialized */
  readonly isReady: boolean;
}
