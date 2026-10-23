/**
 * ISemanticToolFilter — Domain port for query-aware tool result filtering.
 *
 * CC-006 Dynamic Filtering: semantic relevance filter that reduces
 * token usage by ~24% compared to head/tail truncation. Works as a
 * pre-processing stage before IToolResultTruncator applies byte-level cuts.
 *
 * SOTA 2026 Basis: Anthropic context engineering (March 2026) —
 * "Don't just truncate, filter by relevance." Keyword + section-based
 * hybrid strategy preserves structurally important content.
 *
 * @layer Domain (Agents)
 * @pattern CC-006 Dynamic Filtering (FITNESS-K: 69.5)
 * @see src/domain/agents/tool-result-truncator.port.ts — byte-level companion
 * @see src/domain/context/context-compactor.interface.ts — context-level compaction
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Strategy used for semantic filtering.
 */
export type SemanticFilterStrategy = 'keyword' | 'section' | 'hybrid';

/**
 * Result of a semantic filtering operation.
 */
export interface SemanticFilterResult {
  /** Filtered content with irrelevant sections removed */
  readonly filteredContent: string;
  /** Estimated token count of the original content */
  readonly originalTokens: number;
  /** Estimated token count after filtering */
  readonly filteredTokens: number;
  /** Overall relevance score (0.0–1.0) */
  readonly relevanceScore: number;
  /** Strategy that was applied */
  readonly strategy: SemanticFilterStrategy;
  /** Number of sections retained (for section/hybrid strategies) */
  readonly sectionsRetained: number;
  /** Number of sections removed */
  readonly sectionsRemoved: number;
}

/**
 * Options for semantic filtering behavior.
 */
export interface SemanticFilterOptions {
  /** Maximum tokens in the filtered output */
  readonly maxTokens?: number;
  /** Minimum relevance score to retain a section (0.0–1.0, default: 0.1) */
  readonly minRelevanceScore?: number;
  /** Whether to preserve structural elements (headings, code blocks) */
  readonly preserveStructure?: boolean;
  /** Force a specific strategy instead of auto-selecting */
  readonly strategy?: SemanticFilterStrategy;
}

/**
 * A scored section extracted from content.
 */
export interface ScoredSection {
  /** Section text content */
  readonly content: string;
  /** Relevance score relative to query (0.0–1.0) */
  readonly score: number;
  /** Start offset in original content */
  readonly startOffset: number;
  /** End offset in original content */
  readonly endOffset: number;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * ISemanticToolFilter — query-aware relevance filtering for tool results.
 *
 * Pipeline: raw tool output → ISemanticToolFilter → IToolResultTruncator
 *
 * Three strategies:
 * - `keyword`: Fast TF-IDF-like keyword matching per line
 * - `section`: Split by structural markers (headings, blank lines), score sections
 * - `hybrid`: Section-based with keyword boosting within sections
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ISemanticToolFilter {
  /**
   * Filter content by relevance to a query.
   * Removes sections with low relevance scores.
   *
   * @param content - Raw tool result content
   * @param query - User's query or task description for relevance scoring
   * @param options - Filtering configuration
   * @returns Filtered result with metrics
   */
  filterByRelevance(
    content: string,
    query: string,
    options?: SemanticFilterOptions,
  ): SemanticFilterResult;

  /**
   * Estimate overall relevance of content to a query without filtering.
   *
   * @param content - Content to score
   * @param query - Query for relevance comparison
   * @returns Relevance score (0.0–1.0)
   */
  estimateRelevanceScore(content: string, query: string): number;

  /**
   * Extract and score individual sections from content.
   * Returns sections sorted by relevance (highest first).
   *
   * @param content - Content to split into sections
   * @param query - Query for relevance scoring
   * @param maxSections - Maximum sections to return (default: 10)
   * @returns Scored sections sorted by descending relevance
   */
  extractRelevantSections(
    content: string,
    query: string,
    maxSections?: number,
  ): ScoredSection[];
}
