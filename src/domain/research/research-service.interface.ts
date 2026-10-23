/**
 * Research Service — Domain Interface (Port)
 *
 * Facade for research operations: search for sources by topic/query.
 * This is the existing research capability, composed by IDeepResearchService.
 *
 * NOTE: IResearchService wraps the lower-level IArticleFinder/IArticleSummarizer
 * into a single search-oriented interface for consumer convenience.
 *
 * @see IDeepResearchService — composes this service for deep research pipelines
 * @see IArticleFinder, IArticleSummarizer, ITrendAnalyzer — lower-level primitives
 */
import type { CorrelationId } from '@/core/types/branded';
import type { ResearchSource } from './deep-research.interface';

export interface SearchOptions {
  readonly maxResults: number;
  readonly minRelevance?: number;
}

export interface IResearchService {
  /**
   * Search for sources relevant to a query.
   * Returns ranked sources with relevance scores.
   */
  search(
    query: string,
    options: SearchOptions,
    correlationId: CorrelationId,
  ): Promise<readonly ResearchSource[]>;
}
