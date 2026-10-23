/**
 * Embeddings for long-term memory rows.
 * Layer: Domain
 *
 * Writes and queries must use the same model, otherwise vectors live in different spaces.
 */

export const MEMORY_EMBEDDING_MODEL = 'text-embedding-ada-002';

export interface MemoryEmbeddingTarget {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly content: string;
  readonly type: string;
  readonly metadata?: Record<string, unknown>;
}

export interface IMemoryEmbeddingIndexer {
  /** Returns the number of rows that received an embedding. */
  index(targets: ReadonlyArray<MemoryEmbeddingTarget>): Promise<number>;
}

/** Rows that were stored before their embedding was written. */
export interface IUnembeddedMemorySource {
  listUnembedded(limit: number): Promise<ReadonlyArray<MemoryEmbeddingTarget>>;
}
