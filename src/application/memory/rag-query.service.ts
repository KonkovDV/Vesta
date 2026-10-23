/**
 * RagQueryService — Application-layer bridge for RAG queries.
 *
 * Layer: Application
 *
 * MEM-NEXT-STEP1: thin facade over HybridMemoryRetrievalService without LLM calls.
 */

import type { RagContextItem, RagQueryInput } from '../../core/memory/rag-types';
import type { HybridMemoryRetrievalService } from '../../memory/retrieval/hybrid-memory-retrieval.service';

export interface RagQueryServiceDeps {
  retrievalService: HybridMemoryRetrievalService;
}

/**
 * Application-facing RAG service.
 *
 * Responsibilities (STEP1):
 * - normalize incoming query string;
 * - apply default topK when not provided;
 * - delegate retrieval to HybridMemoryRetrievalService.
 */
export class RagQueryService {
  constructor(private readonly deps: RagQueryServiceDeps) {}

  async query(input: RagQueryInput): Promise<RagContextItem[]> {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const effectiveInput: RagQueryInput = {
      ...input,
      query: trimmedQuery,
      topK: input.topK ?? 8,
    };

    return this.deps.retrievalService.retrieveContext(effectiveInput);
  }
}