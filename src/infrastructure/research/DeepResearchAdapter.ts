/**
 * DeepResearchAdapter — Infrastructure Adapter
 *
 * Multi-step deep research pipeline:
 * 1. Decompose query into sub-questions (via LLM)
 * 2. Search sources for each sub-question (via IResearchService)
 * 3. Synthesize answer with citations (via LLM + source references)
 *
 * Composes IResearchService (existing) for source finding + ILLMAdapterFactory
 * for LLM-based decomposition and synthesis. Does NOT replace IResearchService.
 *
 * Best Practices Applied (March 2026):
 * - o3-deep-research pattern: multi-step decomposition + synthesis
 * - Parallel sub-question searching for efficiency
 *   (Dria Research: serial degrades 47-50%)
 * - Intermediate step logging for auditability (Ch.6)
 * - Citation integration in final answer
 *
 * DI: constructor(llmFactory, researchService, logger) — 3 args
 *
 * @see Book Ch.6 "Planning Agents" — Deep Research Pipeline
 */

import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { IResearchService } from '../../domain/research/research-service.interface';
import type {
  IDeepResearchService,
  ResearchQuery,
  ResearchResult,
  ResearchSource,
  Citation,
} from '../../domain/research/deep-research.interface';

/** Max sub-questions per decomposition step */
const MAX_SUB_QUESTIONS = 5;

/** Max concurrent search requests (rate-limit protection against HTTP 429) */
const MAX_CONCURRENT_SEARCHES = 3;

/** Depth → max sources mapping */
const DEPTH_SOURCE_LIMITS: Record<ResearchQuery['depth'], number> = {
  shallow: 3,
  standard: 6,
  deep: 10,
};

export class DeepResearchAdapter implements IDeepResearchService {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly researchService: IResearchService,
    private readonly logger: ILogger,
  ) {}

  async research(
    query: ResearchQuery,
    correlationId: CorrelationId,
  ): Promise<ResearchResult> {
    const startTime = Date.now();
    const intermediateSteps: string[] = [];

    this.logger.info('DeepResearchAdapter.research', {
      correlationId,
      question: query.question.substring(0, 100),
      depth: query.depth,
    });

    // 1. Decompose query into sub-questions
    let subQuestions: readonly string[] = await this.decomposeQuery(query, correlationId);

    // Guard: empty decompose → fallback to original question (C-001 pattern)
    if (subQuestions.length === 0) {
      this.logger.warn('DeepResearchAdapter.emptyDecompose', {
        correlationId,
        question: query.question.substring(0, 100),
      });
      // Fallback: use original question as single sub-question
      subQuestions = [query.question];
    }

    intermediateSteps.push(`Decomposed into ${subQuestions.length} sub-questions`);

    this.logger.info('DeepResearchAdapter.decomposed', {
      correlationId,
      subQuestionCount: subQuestions.length,
    });

    // 2. Search sources for each sub-question
    // FIX-R02: Throttled Promise.allSettled — rate-limit protection (max 3 concurrent)
    const maxSourcesPerQuery = Math.min(
      query.maxSources,
      DEPTH_SOURCE_LIMITS[query.depth],
    );

    const searchResults = await this.throttledSearch(
      subQuestions,
      maxSourcesPerQuery,
      correlationId,
    );
    const totalSearches = subQuestions.length;

    // Flatten and deduplicate sources by URL
    const allSources = this.deduplicateSources(searchResults.flat());
    intermediateSteps.push(`Found ${allSources.length} unique sources from ${totalSearches} searches`);

    this.logger.info('DeepResearchAdapter.sourcesFound', {
      correlationId,
      totalSources: allSources.length,
      totalSearches,
    });

    // 3. Synthesize answer with citations
    const { answer, citations } = await this.synthesizeAnswer(
      query,
      allSources,
      correlationId,
    );
    intermediateSteps.push(`Synthesized answer with ${citations.length} citations`);

    const durationMs = Date.now() - startTime;

    this.logger.info('DeepResearchAdapter.completed', {
      correlationId,
      durationMs,
      totalSources: allSources.length,
      totalCitations: citations.length,
    });

    return {
      answer,
      sources: allSources,
      citations,
      intermediateSteps,
      totalSearches,
      durationMs,
    };
  }

  /** Step 1: Decompose query into focused sub-questions via LLM */
  private async decomposeQuery(
    query: ResearchQuery,
    correlationId: CorrelationId,
  ): Promise<readonly string[]> {
    const { adapter } = await this.llmFactory.createAdapterWithFailover();

    const prompt = [
      'You are a research assistant. Decompose the following research question',
      'into focused sub-questions for thorough investigation.',
      '',
      `Research question: ${query.question}`,
      `Depth: ${query.depth}`,
      '',
      `Return exactly ${Math.min(MAX_SUB_QUESTIONS, query.depth === 'shallow' ? 2 : query.depth === 'deep' ? 5 : 3)} sub-questions,`,
      'each on a new line, numbered 1-N. No other text.',
    ].join('\n');

    this.logger.info('DeepResearchAdapter.decomposeQuery', {
      correlationId,
      depth: query.depth,
    });

    const result = await adapter.generateText(prompt, {
      temperature: 0.2,
      maxTokens: 1024,
    });

    // Parse numbered list
    const questions = result.text
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .filter((line) => line.length > 0);

    return questions.slice(0, MAX_SUB_QUESTIONS);
  }

  /** Step 3: Synthesize answer with citation references */
  private async synthesizeAnswer(
    query: ResearchQuery,
    sources: readonly ResearchSource[],
    correlationId: CorrelationId,
  ): Promise<{ answer: string; citations: Citation[] }> {
    const { adapter } = await this.llmFactory.createAdapterWithFailover();

    const sourceContext = sources
      .map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet}`)
      .join('\n');

    const prompt = [
      'You are a research synthesizer. Answer the following question using the provided sources.',
      query.requireCitations
        ? 'Include inline citations as [N] referencing the source numbers.'
        : '',
      '',
      `Question: ${query.question}`,
      '',
      '=== SOURCES ===',
      sourceContext,
      '',
      'Provide a comprehensive, well-organized answer.',
    ].join('\n');

    this.logger.info('DeepResearchAdapter.synthesizeAnswer', {
      correlationId,
      sourceCount: sources.length,
      requireCitations: query.requireCitations,
    });

    const result = await adapter.generateText(prompt, {
      temperature: 0.5,
      maxTokens: 4096,
    });
    const answer = result.text;

    // Extract citations from [N] references in answer
    const citations: Citation[] = [];
    if (query.requireCitations) {
      const citationRegex = /\[(\d+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = citationRegex.exec(answer)) !== null) {
        const sourceIndex = parseInt(match[1], 10) - 1;
        if (sourceIndex >= 0 && sourceIndex < sources.length) {
          // Extract surrounding text as citation context
          const start = Math.max(0, match.index - 50);
          const end = Math.min(answer.length, match.index + match[0].length + 50);
          const text = answer.substring(start, end).trim();

          citations.push({
            text,
            sourceIndex,
          });
        }
      }
    }

    return { answer, citations };
  }

  /**
   * FIX-R02: Throttled parallel search with concurrency limit.
   * Prevents HTTP 429 Too Many Requests from search APIs during deep research.
   * Uses Promise.allSettled for resilience — failed searches don't crash pipeline.
   */
  private async throttledSearch(
    questions: readonly string[],
    maxSourcesPerQuery: number,
    correlationId: CorrelationId,
  ): Promise<ResearchSource[][]> {
    const results: ResearchSource[][] = [];
    // Process in batches of MAX_CONCURRENT_SEARCHES
    for (let i = 0; i < questions.length; i += MAX_CONCURRENT_SEARCHES) {
      const batch = questions.slice(i, i + MAX_CONCURRENT_SEARCHES);
      const settled = await Promise.allSettled(
        batch.map((sq) =>
          this.researchService.search(
            sq,
            { maxResults: maxSourcesPerQuery },
            correlationId,
          ),
        ),
      );

      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j];
        if (outcome.status === 'fulfilled') {
          results.push([...outcome.value]);
        } else {
          this.logger.warn('DeepResearchAdapter.searchFailed', {
            correlationId,
            question: batch[j].substring(0, 80),
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
          results.push([]); // Empty results for failed search — don't crash pipeline
        }
      }
    }
    return results;
  }

  /** Deduplicate sources by URL, keeping highest relevance */
  private deduplicateSources(sources: readonly ResearchSource[]): ResearchSource[] {
    const seen = new Map<string, ResearchSource>();
    for (const source of sources) {
      const existing = seen.get(source.url);
      if (!existing || source.relevanceScore > existing.relevanceScore) {
        seen.set(source.url, source);
      }
    }
    return [...seen.values()].sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
}
