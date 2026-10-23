/**
 * Deep Research Service — Domain Interface (Port)
 *
 * Multi-step deep research pipeline:
 * 1. Decompose query into sub-questions
 * 2. Search sources for each sub-question (via IResearchService composition)
 * 3. Synthesize answer with citations
 *
 * NOTE: IDeepResearchService **composes** (does NOT replace) the existing
 * IResearchService. Both DI tokens coexist with different APIs:
 * - IResearchService: find articles, summarize, analyze trends
 * - IDeepResearchService: decompose → search → synthesize pipeline
 *
 * Best Practices Applied (March 2026):
 * - o3-deep-research pattern: multi-step decomposition + synthesis
 * - Citation annotation for source provenance (Ch.6)
 * - Intermediate step logging for auditability
 *
 * @see Book Ch.6 "Planning Agents" — Deep Research Pipeline
 * @see Gulli, "Agentic Design Patterns" (Springer 2026)
 */
import type { CorrelationId } from '@/core/types/branded';

export interface ResearchQuery {
  readonly question: string;
  readonly depth: 'shallow' | 'standard' | 'deep';
  readonly maxSources: number;
  readonly requireCitations: boolean;
}

export interface ResearchSource {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly relevanceScore: number;
}

export interface Citation {
  readonly text: string;
  readonly sourceIndex: number;
  readonly pageOrSection?: string;
}

export interface ResearchResult {
  readonly answer: string;
  readonly sources: readonly ResearchSource[];
  readonly citations: readonly Citation[];
  readonly intermediateSteps: readonly string[];
  readonly totalSearches: number;
  readonly durationMs: number;
}

export interface IDeepResearchService {
  /**
   * Conduct deep research: decompose → search → synthesize with citations.
   * Uses IResearchService internally for article finding + LLM for synthesis.
   */
  research(
    query: ResearchQuery,
    correlationId: CorrelationId,
  ): Promise<ResearchResult>;
}
