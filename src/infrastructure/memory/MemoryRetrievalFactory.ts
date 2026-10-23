/**
 * MemoryRetrievalFactory — фабрика для создания доменных сервисов поиска по памяти.
 * Layer: Infrastructure
 *
 * Предоставляет централизованные factory-функции для:
 * - AdvancedRetrievalService (расширенный поиск поверх IVectorStore)
 * - HybridMemoryRetrievalService (гибридный поиск поверх HSG/Vector клиентов)
 *
 * Composition of the retrieval services belongs next to the other memory adapters.
 */

import type { IVectorStore } from '../../domain/memory/IVectorStore';
import type { QueryEmbedder } from '../../domain/memory/services/query-embedding';
import type { HSGClient } from '../../domain/memory/session-memory-ports';
import type { IProfileMemory } from '../../domain/memory/IProfileMemory';
import { AdvancedRetrievalService } from '../../domain/memory/AdvancedRetrievalService';
import {
  HybridMemoryRetrievalService,
  type HsgSearchClient,
  type TextSearchClient,
} from './retrieval/hybrid-memory-retrieval.service';
import type { RagQueryInput } from '../../core/memory/rag-types';
import { IdGenerator } from '../../core/utils/IdGenerator';

/**
 * Опции создания AdvancedRetrievalService
 */
export interface CreateAdvancedRetrievalServiceOptions {
  /** Обязательный VectorStore для поиска */
  vectorStore: IVectorStore;

  /** Опциональный reader для snapshot-поиска по Session Memory (L1) */
  memoryReader?: {
    searchMemory(request: {
      tenantId: string;
      sessionId?: string;
      query: string;
      topK: number;
      filters?: Record<string, unknown>;
    }): Promise<
      Array<{
        id: string;
        content: string;
        score?: number;
        metadata?: Record<string, unknown>;
      }>
    >;
  };

  /** Same embedder port HybridSearchService uses. Without it, vector search is skipped. */
  embedder?: QueryEmbedder;

  /** Опциональный distiller/fact reader для поиска по Mem0 (L2) */
  semanticFactReader?: {
    searchMemory(request: {
        tenantId: string;
        sessionId?: string;
        query: string;
        topK: number;
        filters?: Record<string, unknown>;
      }): Promise<
        Array<{
          id: string;
          content: string;
          score?: number;
          metadata?: Record<string, unknown>;
        }>
      >;
  };
}

/**
 * Создать AdvancedRetrievalService
 */
export function createAdvancedRetrievalService(
  options: CreateAdvancedRetrievalServiceOptions,
): AdvancedRetrievalService {
  // Factory: assemble the domain retrieval service from its ports.
  return new AdvancedRetrievalService(
      options.vectorStore, 
      options.memoryReader,
      options.semanticFactReader,
      options.embedder,
  );
}

/**
 * Адаптер HSG клиента для HybridMemoryRetrievalService
 */
function createHsgSearchClient(hsgClient: HSGClient): HsgSearchClient {
  return {
    async searchKnowledgeBase(input: RagQueryInput) {
      if (input.scopes && input.scopes.kb === false) {
        return [];
      }

      const filters: Record<string, unknown> = { ...(input.filters ?? {}) };
      if (filters['kind'] === undefined) {
        filters['kind'] = 'kb_document';
      }

      const results = await hsgClient.query({
        tenant_id: input.tenantId,
        user_id: input.userId,
        session_id: input.sessionId,
        sector: 'semantic',
        query: input.query,
        filters,
        limit: input.topK,
      });

      return results.map((item) => ({
        id: item.pointer.hsg_id,
        score: item.score,
        snippet: item.content,
        metadata: item.metadata,
      }));
    },
  };
}

/**
 * Адаптер IProfileMemory для TextSearchClient
 */
function createTextSearchClient(store: IProfileMemory): TextSearchClient {
  return {
    async searchUserMemory(input: RagQueryInput) {
       const entries = await store.search({
         tenantId: input.tenantId,
         userId: input.userId || 'anonymous',
         query: input.query,
         limit: input.topK,
       });
       
       return entries.map(entry => {
         const meta = entry.metadata as Record<string, unknown> || {};
         const dbId = typeof meta.db_id === 'string' ? meta.db_id : null;
         
         return {
           id: dbId || IdGenerator.generateWithPrefix('ltm'),
           score: entry.importance ?? 0,
           snippet: entry.summary,
           metadata: { ...entry, kind: 'long_term_memory' }
         };
       });
    }
  };
}

/**
 * Опции создания HybridMemoryRetrievalService
 */
export interface CreateHybridMemoryRetrievalServiceOptions {
  /** HSG клиент для поиска по Knowledge Base */
  hsgClient?: HSGClient;
  
  /** Profile memory plane for text-based user-profile retrieval */
  profileMemory?: IProfileMemory;

  /** Флаг включения graph-aware expand+rescore */
  enableGraphExpand?: boolean;
}

/**
 * Создать HybridMemoryRetrievalService
 */
export function createHybridMemoryRetrievalService(
  options: CreateHybridMemoryRetrievalServiceOptions,
): HybridMemoryRetrievalService {
  const hsgClient = options.hsgClient
    ? createHsgSearchClient(options.hsgClient)
    : undefined;

  const textClient = options.profileMemory
    ? createTextSearchClient(options.profileMemory)
    : undefined;

  // Factory: assemble the hybrid retrieval service from its ports.
  return new HybridMemoryRetrievalService({
    hsgClient,
    textClient,
    enableGraphExpand: options.enableGraphExpand,
  });
}
