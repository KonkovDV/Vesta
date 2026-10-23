/**
 * MemoryEmbeddingIndexer
 *
 * Embeds long-term memory rows and stores the vectors through IVectorStore.
 *
 * Layer: Domain
 */
import type { IAIClient } from '../../ai/IAIClient';
import type { IVectorStore } from '../IVectorStore';
import {
  MEMORY_EMBEDDING_MODEL,
  type IMemoryEmbeddingIndexer,
  type IUnembeddedMemorySource,
  type MemoryEmbeddingTarget,
} from '../IMemoryEmbeddingIndexer';

export class MemoryEmbeddingIndexer implements IMemoryEmbeddingIndexer {
  constructor(
    private readonly vectorStore: IVectorStore,
    private readonly aiClient: IAIClient,
  ) {}

  async index(targets: ReadonlyArray<MemoryEmbeddingTarget>): Promise<number> {
    const unique = [
      ...new Map(
        targets
          .filter((target) => target.content.trim().length > 0)
          .map((target) => [target.id, target] as const),
      ).values(),
    ];
    if (unique.length === 0) {
      return 0;
    }

    const { embeddings } = await this.aiClient.generateEmbeddings(
      unique.map((target) => target.content),
      { model: MEMORY_EMBEDDING_MODEL },
    );
    if (!Array.isArray(embeddings) || embeddings.length !== unique.length) {
      throw new Error(
        `MemoryEmbeddingIndexer: expected ${unique.length} embeddings, got ${Array.isArray(embeddings) ? embeddings.length : 0}`,
      );
    }

    await this.vectorStore.upsertEmbeddings(
      unique.map((target, index) => ({
        id: target.id,
        embedding: embeddings[index],
        namespace: target.tenantId,
        metadata: {
          ...target.metadata,
          tenantId: target.tenantId,
          userId: target.userId,
          content: target.content,
          type: target.type,
          embeddingModel: MEMORY_EMBEDDING_MODEL,
        },
      })),
    );
    return unique.length;
  }
}

/**
 * Embeds stored rows that have no vector yet, one batch at a time.
 * Stops with an error when a row comes back unembedded: the vector store does not write the source table.
 */
export async function backfillMemoryEmbeddings(
  source: IUnembeddedMemorySource,
  indexer: IMemoryEmbeddingIndexer,
  batchSize = 100,
): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  for (;;) {
    const rows = await source.listUnembedded(batchSize);
    if (rows.length === 0) {
      return total;
    }
    const repeated = rows.find((row) => seen.has(row.id));
    if (repeated) {
      throw new Error(
        `backfillMemoryEmbeddings: row ${repeated.id} is still unembedded; IVectorStore does not write long_term_memories`,
      );
    }
    rows.forEach((row) => seen.add(row.id));
    total += await indexer.index(rows);
  }
}
