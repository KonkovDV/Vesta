/**
 * AdvancedRetrievalService — доменный сервис расширенного поиска по памяти.
 *
 * Layer: Domain
 *
 * EV18.2: skeleton поверх IVectorStore + абстракции чтения Session Memory.
 */

import type {
  IVectorStore,
  VectorSearchQuery,
  VectorSearchResult,
  VectorSearchFilters,
} from './IVectorStore';
import { embedSearchQuery, type QueryEmbedder } from './services/query-embedding';

export type AdvancedRetrievalSource = 'memory' | 'vector' | 'hybrid';

export interface AdvancedRetrievalRequest {
  tenantId: string;
  sessionId?: string;
  query: string;
  topK?: number;
  namespace?: string;
  filters?: VectorSearchFilters;
}

export interface AdvancedRetrievalItem {
  id: string;
  score: number;
  source: AdvancedRetrievalSource;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AdvancedRetrievalResult {
  items: AdvancedRetrievalItem[];
}

export interface MemorySearchRequest {
  tenantId: string;
  sessionId?: string;
  query: string;
  topK: number;
  filters?: Record<string, unknown>;
}

export interface MemorySearchItem {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Доменная абстракция поверх Session Memory / Phase 11.
 *
 * Реализация будет предоставлена в Memory-слое (например, поверх SessionMemoryManager).
 */
export interface IMemorySnapshotReader {
  searchMemory(request: MemorySearchRequest): Promise<MemorySearchItem[]>;
}

const DEFAULT_TOP_K = 20;

export class AdvancedRetrievalService {
  constructor(
    private readonly vectorStore: IVectorStore,
    private readonly memoryReader?: IMemorySnapshotReader,
    private readonly semanticFactReader?: IMemorySnapshotReader, // New: Mem0 facts
    private readonly embedder?: QueryEmbedder,
  ) {}

  async search(request: AdvancedRetrievalRequest): Promise<AdvancedRetrievalResult> {
    const normalizedQuery = request.query.trim();
    if (!normalizedQuery) {
      throw new Error('AdvancedRetrievalService.search: query must be a non-empty string');
    }

    const topK = !request.topK || request.topK <= 0 ? DEFAULT_TOP_K : request.topK;
    const tenantId = request.tenantId.trim();

    const vectorPromise = this.searchVectors(tenantId, normalizedQuery, topK, request.filters);

    const memoryPromise = this.memoryReader
      ? this.memoryReader.searchMemory({
          tenantId: request.tenantId,
          sessionId: request.sessionId,
          query: normalizedQuery,
          topK,
          filters: request.filters,
        })
      : Promise.resolve<MemorySearchItem[]>([]);

    const factPromise = this.semanticFactReader
      ? this.semanticFactReader.searchMemory({
          tenantId: request.tenantId,
          sessionId: request.sessionId,
          query: normalizedQuery,
          topK,
          filters: request.filters,
        })
      : Promise.resolve<MemorySearchItem[]>([]);

    const [vectorResults, memoryItems, factItems] = await Promise.all([
        vectorPromise, 
        memoryPromise,
        factPromise
    ]);

    const vectorMapped = vectorResults.map<AdvancedRetrievalItem>((result) => ({
      id: result.id,
      score: result.score,
      source: 'vector',
      content: this.resolveVectorContent(result),
      metadata: result.metadata,
    }));

    const memoryMapped = memoryItems.map<AdvancedRetrievalItem>((item) => ({
      id: item.id,
      score: typeof item.score === 'number' ? item.score : 0.8, // episodic weight
      source: 'memory',
      content: item.content,
      metadata: item.metadata,
    }));

    const factMapped = factItems.map<AdvancedRetrievalItem>((item) => ({
      id: item.id,
      score: typeof item.score === 'number' ? item.score : 0.95, // semantic weight (Mem0)
      source: 'hybrid',
      content: item.content,
      metadata: item.metadata,
    }));

    const items = [...memoryMapped, ...factMapped, ...vectorMapped];
    items.sort((a, b) => b.score - a.score);

    return { items };
  }

  /** No embedder or no tenant: the vector store is not called. */
  private async searchVectors(
    tenantId: string,
    query: string,
    topK: number,
    filters: VectorSearchQuery['filters'],
  ): Promise<VectorSearchResult[]> {
    if (!tenantId || !this.embedder) {
      return [];
    }
    try {
      const queryEmbedding = await embedSearchQuery(this.embedder, query);
      if (!queryEmbedding) {
        return [];
      }
      return await this.vectorStore.search({
        queryEmbedding,
        topK,
        namespace: tenantId,
        filters,
      });
    } catch {
      return [];
    }
  }

  private resolveVectorContent(result: VectorSearchResult): string {
    const metadata = result.metadata ?? {};
    const content =
      (metadata['content'] as string | undefined) ??
      (metadata['summary'] as string | undefined);

    return content ?? '';
  }
}