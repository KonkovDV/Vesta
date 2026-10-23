/**
 * HybridSearchService
 * 
 * Implements Hybrid Search combining Vector Search (Sqlite) and Keyword Search (Postgres FTS)
 * using Reciprocal Rank Fusion (RRF).
 * 
 * Layer: Domain
 */
import { injectable, inject } from 'inversify';
import { IVectorStore, VectorSearchResult } from '../IVectorStore';
import { PROFILE_MEMORY_TYPES, type IProfileMemory } from '../IProfileMemory';
import { MEMORY_EMBEDDING_MODEL } from '../IMemoryEmbeddingIndexer';
import { IAIClient } from '../../ai/IAIClient'; // Using IAIClient as embedder interface

export interface HybridSearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  sources: ('vector' | 'keyword')[];
}

type HybridSource = 'vector' | 'keyword';

interface RankedHybridItem {
  content: string;
  metadata: Record<string, unknown>;
  sources: Set<HybridSource>;
}

function toEmbedding(result: { embeddings: number[][] }): number[] | null {
  return Array.isArray(result.embeddings) && result.embeddings.length > 0 ? result.embeddings[0] : null;
}

@injectable()
export class HybridSearchService {
  private readonly RRF_K = 60; // Standard constant for RRF

  constructor(
    @inject('IVectorStore') private vectorStore: IVectorStore,
    @inject('IProfileMemory') private profileMemory: IProfileMemory,
    @inject('IAIClient') private aiClient: IAIClient // Ensure this token is bound to OpenAIAdapter or similar
  ) {}

  async search(
    tenant_id: string,
    user_id: string,
    query: string,
    limit: number = 10
  ): Promise<HybridSearchResult[]> {
    // 1. Parallel Execution: Embedding + Keyword Search
    // We start embedding generation and keyword search concurrently.
    
    // 1a. Generate Embedding
    const embeddingPromise = this.aiClient.generateEmbeddings([query], { model: MEMORY_EMBEDDING_MODEL })
      .then((res) => toEmbedding(res))
      .catch((err: unknown) => {
        console.error('[HybridSearch] Embedding generation failed', err);
        return null; // Fallback to keyword-only if embedding fails
      });

    // Keyword search does not need the embedding. Vector search starts as soon as the embedding exists.
    const keywordPromise = this.profileMemory.search({
      tenantId: tenant_id,
      userId: user_id,
      query,
      limit: limit * 2,
    });
    const vectorPromise = embeddingPromise.then(async (queryEmbedding) => {
      if (!queryEmbedding) return [] as VectorSearchResult[];
      try {
        return await this.vectorStore.search({
          queryEmbedding,
          topK: limit * 2,
          namespace: tenant_id,
          filters: { userId: user_id, types: [...PROFILE_MEMORY_TYPES] },
        });
      } catch (err) {
        console.error('[HybridSearch] Vector search failed', err);
        return [] as VectorSearchResult[];
      }
    });

    const [vectorResults, keywordResults] = await Promise.all([vectorPromise, keywordPromise]);

    // 2. Reciprocal Rank Fusion (RRF)
    const scores = new Map<string, number>();
    const items = new Map<string, RankedHybridItem>();

    // Process Vector Results
    vectorResults.forEach((item, index) => {
      // Avoid raw scores, use rank
      const score = 1 / (this.RRF_K + index + 1);
      
      const currentScore = scores.get(item.id) || 0;
      scores.set(item.id, currentScore + score);
      
      if (!items.has(item.id)) {
        items.set(item.id, {
          content: (item.metadata?.content as string) || (item.metadata?.summary as string) || '',
          metadata: item.metadata || {},
          sources: new Set(['vector'])
        });
      } else {
        items.get(item.id)!.sources.add('vector');
      }
    });

    // Process Keyword Results
    // Keyword results don't have explicit IDs in the Interface return type (WorkingMemoryEntry),
    // but Postgres implementation puts 'db_id' in metadata.
    keywordResults.forEach((item, index: number) => {
      const id = item.metadata?.db_id as string;
      if (!id) return; // Skip if no ID found

      const score = 1 / (this.RRF_K + index + 1);
      
      const currentScore = scores.get(id) || 0;
      scores.set(id, currentScore + score);

      if (!items.has(id)) {
        items.set(id, {
          content: item.summary,
          metadata: item.metadata || {},
          sources: new Set(['keyword'])
        });
      } else {
        items.get(id)!.sources.add('keyword');
      }
    });

    // 3. Sort and Format
    const finalResults: HybridSearchResult[] = Array.from(scores.entries())
      .map(([id, score]) => {
        const item = items.get(id)!;
        return {
          id,
          score,
          content: item.content,
          metadata: item.metadata,
          sources: Array.from(item.sources)
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return finalResults;
  }
}
