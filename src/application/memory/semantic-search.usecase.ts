/**
 * SemanticSearchUseCase — Application-level semantic search facade over HybridMemoryRetrievalService.
 *
 * Layer: Application
 *
 * CODE-MEM-NEXT-STEP1: minimal DTO mapping for hybrid semantic search.
 */

import type { RagContextItem, RagQueryInput } from '../../core/memory/rag-types';
import type { HybridMemoryRetrievalService } from '../../memory/retrieval/hybrid-memory-retrieval.service';
import type { IRequestContext } from '../context/request-context';

export type SemanticSearchSource = 'kb' | 'user_profile';

export interface SemanticSearchResultItemDto {
  id?: string;
  text: string;
  score: number;
  source: SemanticSearchSource;
  metadata?: Record<string, unknown>;
}

export interface SemanticSearchResultDto {
  items: SemanticSearchResultItemDto[];
}

export interface SemanticSearchUseCaseOptions {
  topK?: number;
  tenantId?: string;
}

/**
 * Thin Application-layer use case that:
 * - derives tenant/user/session from RequestContext;
 * - delegates retrieval to HybridMemoryRetrievalService;
 * - maps RagContextItem[] to API-facing DTO.
 */
export class SemanticSearchUseCase {
  constructor(private readonly retrievalService: HybridMemoryRetrievalService) {}

  async searchSemantic(
    query: string,
    ctx: IRequestContext,
    options?: SemanticSearchUseCaseOptions,
  ): Promise<SemanticSearchResultDto> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { items: [] };
    }

    const baseContext = ctx.getContext();

    const tenantId =
      options?.tenantId ??
      (baseContext.tenantId ? String(baseContext.tenantId) : 'unknown');

    const userId = baseContext.userId ? String(baseContext.userId) : undefined;
    const sessionId = baseContext.sessionId ? String(baseContext.sessionId) : undefined;

    const input: RagQueryInput = {
      tenantId,
      userId,
      sessionId,
      query: trimmed,
      topK: options?.topK,
    };

    const contextItems = await this.retrievalService.retrieveContext(input);

    return {
      items: contextItems.map((item) => this.mapItem(item)),
    };
  }

  private mapItem(item: RagContextItem): SemanticSearchResultItemDto {
    const source: SemanticSearchSource =
      item.sourceType === 'kb' ? 'kb' : 'user_profile';

    return {
      id: item.id,
      text: item.text,
      score: item.score,
      source,
      metadata: item.metadata,
    };
  }
}