/**
 * HybridMemoryRetrievalService — RAG-oriented read-only bridge over Phase 11 memory.
 *
 * Layer: Infrastructure
 *
 * MEM-NEXT-STEP2: minimal hybrid retrieval over abstract HSG/Vector clients.
 * MEM-NEXT-STEP1: optional graph-aware expand+rescore over KB results.
 */

import type { RagQueryInput, RagContextItem } from '../../../core/memory/rag-types';
import type { HSGClient, HSGQueryResultItem } from '../../../domain/memory/session-memory-ports';
import {
  recordBackendError,
  recordHybridGraphExpandDuration,
  incrementHybridGraphNeighborsTotal,
} from '../../../monitoring/memory-retrieval-metrics';

export interface HsgSearchResult {
  id: string;
  score: number;
  snippet: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  snippet: string;
  metadata?: Record<string, unknown>;
}

/**
 * Abstract HSG search client used by HybridMemoryRetrievalService.
 * Real infrastructure clients (OpenMemoryHSGClient, etc.) should adapt to this contract.
 */
export interface HsgSearchClient {
  /**
   * Performs semantic/graph search over knowledge base collections.
   */
  searchKnowledgeBase(input: RagQueryInput): Promise<HsgSearchResult[]>;
}

export interface VectorSearchClient {
  /**
   * Performs vector search over user/session long-term memory.
   */
  searchUserMemory(input: RagQueryInput): Promise<VectorSearchResult[]>;
}

export interface TextSearchClient {
  /**
   * Performs BM25 text search over user/session long-term memory.
   */
  searchUserMemory(input: RagQueryInput): Promise<VectorSearchResult[]>;
}

export interface HybridMemoryRetrievalDeps {
  /**
   * Optional HSG search client. When present it is used to query knowledge base.
   */
  hsgClient?: HsgSearchClient;

  /**
   * Optional vector search client. When present it is used to query user/session memory.
   */
  vectorClient?: VectorSearchClient;

  /**
   * Optional BM25 text search client.
   */
  textClient?: TextSearchClient;

  /**
   * Optional full HSG client used for graph-aware expand+rescore (neighbors lookup).
   */
  hsgGraphClient?: HSGClient;

  /**
   * Feature-flag for MEM-NEXT Step1 graph-aware expand+rescore.
   *
   * When false/undefined the behaviour is identical to the original implementation.
   */
  enableGraphExpand?: boolean;
}

const DEFAULT_GRAPH_EXPAND_TOP_N = 3;
const DEFAULT_GRAPH_NEIGHBOR_LIMIT_PER_DOC = 5;
const DEFAULT_GRAPH_BASE_BOOST_MULTIPLIER = 1.1;
const DEFAULT_GRAPH_NEIGHBOR_SCORE_FACTOR = 0.8;

/**
 * Read-only retrieval facade that combines HSG and Vector results into RagContextItem[].
 *
 * STEP2: executes both backends when available, tolerating individual backend failures.
 * STEP1: optionally performs graph-aware expand+rescore over KB results when enabled.
 */
export class HybridMemoryRetrievalService {
  constructor(private readonly deps: HybridMemoryRetrievalDeps = {}) {}

  async retrieveContext(input: RagQueryInput): Promise<RagContextItem[]> {
    const hsgPromise = this.deps.hsgClient
      ? this.deps.hsgClient.searchKnowledgeBase(input).catch((error: unknown) => {
          recordBackendError({ backend: 'hsg', operation: 'search', error });
          return [] as HsgSearchResult[];
        })
      : Promise.resolve([] as HsgSearchResult[]);

    const vectorPromise = this.deps.vectorClient
      ? this.deps.vectorClient.searchUserMemory(input).catch((error: unknown) => {
          recordBackendError({ backend: 'vector', operation: 'search', error });
          return [] as VectorSearchResult[];
        })
      : Promise.resolve([] as VectorSearchResult[]);

    const textPromise = this.deps.textClient
      ? this.deps.textClient.searchUserMemory(input).catch((error: unknown) => {
          recordBackendError({ backend: 'text', operation: 'search', error });
          return [] as VectorSearchResult[];
        })
      : Promise.resolve([] as VectorSearchResult[]);

    const [hsgSettled, vectorSettled, textSettled] = await Promise.allSettled([
      hsgPromise,
      vectorPromise,
      textPromise,
    ]);
    const hsgResults = hsgSettled.status === 'fulfilled' ? hsgSettled.value : [];
    const vectorResults = vectorSettled.status === 'fulfilled' ? vectorSettled.value : [];
    const textResults = textSettled.status === 'fulfilled' ? textSettled.value : [];

    let kbItems = hsgResults.map<RagContextItem>((item) => ({
      id: item.id,
      sourceType: 'kb',
      score: item.score,
      text: item.snippet,
      metadata: item.metadata,
    }));

    if (this.deps.enableGraphExpand && this.deps.hsgGraphClient && kbItems.length > 0) {
      kbItems = await this.expandAndRescoreWithGraph(input, kbItems);
    }

    const userItems = vectorResults.map<RagContextItem>((item) => ({
      id: item.id,
      sourceType: 'user_profile',
      score: item.score,
      text: item.snippet,
      metadata: { ...item.metadata, retrieval_method: 'vector' },
    }));

    const textItems = textResults.map<RagContextItem>((item) => ({
      id: item.id,
      sourceType: 'user_profile',
      score: item.score, // BM25 rank
      text: item.snippet,
      metadata: { ...item.metadata, retrieval_method: 'bm25' },
    }));

    // RRF (Reciprocal Rank Fusion)
    // k = 60 is standard constant.
    const k = 60;
    const rrfScores = new Map<string, number>();
    const itemsMap = new Map<string, RagContextItem>();

    // Helper to process list
    const processList = (list: RagContextItem[]) => {
      // Assuming list is already sorted by backend score Descending? 
      // HSG/Vector/Text clients typically return top K sorted.
      // We explicitly sort primarily to be safe.
      const protectedList = [...list].sort((a, b) => b.score - a.score);
      
      protectedList.forEach((item, index) => {
        const docId = this.getKbDocumentKey(item) || item.id;
        const currentScore = rrfScores.get(docId) || 0;
        const rank = index + 1;
        rrfScores.set(docId, currentScore + (1 / (k + rank)));
        
        if (!itemsMap.has(docId)) {
           itemsMap.set(docId, item);
        } else {
           // If item exists, maybe merge metadata? 
           // For now, keep first seen (typically highest priority source if we had one, but here parallel).
           // Or keep the one with max raw score? RRF abstracts raw score.
           // We keep the one from the source that found it first in iteration order (KB -> Vector -> Text).
        }
      });
    };

    processList(kbItems);
    processList(userItems);
    processList(textItems);

    const combined = Array.from(itemsMap.values()).map(item => {
      const docId = this.getKbDocumentKey(item) || item.id;
      const rrfScore = rrfScores.get(docId) || 0;
      return {
        ...item,
        score: rrfScore, // Replace backend score with RRF score
        metadata: { ...item.metadata, rrf_original_score: item.score }
      };
    });

    // Sort by RRF score Descending
    combined.sort((a, b) => b.score - a.score);

    if (this.deps.enableGraphExpand) {
      // When graph-expand is enabled, sort the whole hybrid set by (possibly updated) score.
      return combined.slice().sort((a, b) => b.score - a.score);
    }

    // Legacy behaviour: simple concatenation without additional ranking.
    return combined;
  }

  /**
   * Derives a stable KB document key for de-duplication and graph lookups.
   *
   * Prefers explicit metadata.kb_document_id when present, falls back to RagContextItem.id.
   */
  private getKbDocumentKey(item: RagContextItem): string | null {
    const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    const kbIdValue = metadata['kb_document_id'];

    if (typeof kbIdValue === 'string' && kbIdValue.length > 0) {
      return kbIdValue;
    }

    const kindValue = metadata['kind'];
    if (typeof kindValue === 'string' && kindValue === 'kb_document') {
      return item.id;
    }

    return null;
  }

  /**
   * MEM-NEXT Step1: graph-aware expand+rescore for KB results.
   *
   * - Selects top-N KB items by score.
   * - For each item asks HSG for neighbors with relationship=related.
   * - Adds new neighbor items (no duplicates) with attenuated score.
   * - Slightly boosts base items that received neighbors.
   * - Emits observability metrics and records backend errors on failure.
   *
   * Any error in this method results in a graceful fallback to the original kbItems.
   */
  private async expandAndRescoreWithGraph(
    input: RagQueryInput,
    kbItems: RagContextItem[],
  ): Promise<RagContextItem[]> {
    const graphClient = this.deps.hsgGraphClient;
    if (!graphClient || kbItems.length === 0) {
      return kbItems;
    }

    const startTimeMs = Date.now();
    let outcome: 'success' | 'error' = 'success';
    let addedNeighbors = 0;

    try {
      const sortedByScore = [...kbItems].sort((a, b) => b.score - a.score);

      const candidates: RagContextItem[] = [];
      for (const item of sortedByScore) {
        if (candidates.length >= DEFAULT_GRAPH_EXPAND_TOP_N) {
          break;
        }
        if (this.getKbDocumentKey(item)) {
          candidates.push(item);
        }
      }

      if (candidates.length === 0) {
        return kbItems;
      }

      const existingDocKeys = new Set<string>();
      for (const item of kbItems) {
        const key = this.getKbDocumentKey(item);
        if (key) {
          existingDocKeys.add(key);
        } else {
          existingDocKeys.add(item.id);
        }
      }

      const neighborItems: RagContextItem[] = [];

      for (const baseItem of candidates) {
        const sourceKey = this.getKbDocumentKey(baseItem);
        if (!sourceKey) {
          continue;
        }

        const neighborResults: HSGQueryResultItem[] = await graphClient.query({
          tenant_id: input.tenantId,
          user_id: input.userId,
          session_id: input.sessionId,
          query: input.query,
          filters: {
            relationship: 'related',
            source_id: sourceKey,
          },
          limit: DEFAULT_GRAPH_NEIGHBOR_LIMIT_PER_DOC,
        });

        let localAdded = 0;

        for (const neighbor of neighborResults) {
          const neighborMetadata: Record<string, unknown> = neighbor.metadata ?? {};
          const rawDocId = neighborMetadata['kb_document_id'];
          const neighborDocKey =
            typeof rawDocId === 'string' && rawDocId.length > 0
              ? rawDocId
              : neighbor.pointer.hsg_id;

          if (existingDocKeys.has(neighborDocKey)) {
            // Already present as base KB result or previously added neighbor.
            continue;
          }

          existingDocKeys.add(neighborDocKey);

          const metadata: Record<string, unknown> = { ...neighborMetadata };
          metadata['expandedByGraph'] = true;
          metadata['graphRelationships'] = [
            {
              sourceId: sourceKey,
              relationship:
                (neighborMetadata['relationship'] as string | undefined) ?? 'related',
            },
          ];

          const neighborItem: RagContextItem = {
            id: neighbor.pointer.hsg_id,
            sourceType: 'kb',
            score: neighbor.score * DEFAULT_GRAPH_NEIGHBOR_SCORE_FACTOR,
            text: neighbor.content,
            metadata,
          };

          neighborItems.push(neighborItem);
          localAdded += 1;
          addedNeighbors += 1;
        }

        if (localAdded > 0) {
          const baseMetadata: Record<string, unknown> = { ...(baseItem.metadata ?? {}) };
          const previousCount =
            typeof baseMetadata['graphNeighborsCount'] === 'number'
              ? (baseMetadata['graphNeighborsCount'] as number)
              : 0;

          baseMetadata['graphBoosted'] = true;
          baseMetadata['graphNeighborsCount'] = previousCount + localAdded;

          baseItem.metadata = baseMetadata;
          baseItem.score = baseItem.score * DEFAULT_GRAPH_BASE_BOOST_MULTIPLIER;
        }
      }

      if (neighborItems.length === 0) {
        // No effective expansion happened, but we still treat it as success.
        return kbItems;
      }

      const combinedKb = [...kbItems, ...neighborItems];
      combinedKb.sort((a, b) => b.score - a.score);
      return combinedKb;
    } catch (error) {
      outcome = 'error';
      recordBackendError({ backend: 'hsg', operation: 'kb_graph_expand', error });
      return kbItems;
    } finally {
      const durationSeconds = (Date.now() - startTimeMs) / 1000;
      recordHybridGraphExpandDuration({ outcome, durationSeconds });
      if (outcome === 'success' && addedNeighbors > 0) {
        incrementHybridGraphNeighborsTotal({ outcome: 'success', count: addedNeighbors });
      }
    }
  }
}