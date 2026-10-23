import type { IAIClient } from '../../ai/IAIClient';
import { MEMORY_EMBEDDING_MODEL } from '../IMemoryEmbeddingIndexer';

/** Same model HybridSearchService sends to IAIClient.generateEmbeddings. */
export type QueryEmbedder = Pick<IAIClient, 'generateEmbeddings'>;

export async function embedSearchQuery(
  embedder: QueryEmbedder,
  query: string,
): Promise<number[] | null> {
  const result = await embedder.generateEmbeddings([query], { model: MEMORY_EMBEDDING_MODEL });
  const vector = result.embeddings?.[0];
  return Array.isArray(vector) && vector.length > 0 ? vector : null;
}
