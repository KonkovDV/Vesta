/**
 * Query Expansion Service — Domain port for extracting meaningful keywords
 * from conversational queries for FTS (Full-Text Search) fallback.
 *
 * Supports 8 languages: English, Spanish, Portuguese, Arabic, Korean,
 * Japanese, Chinese, and generic Unicode. Includes:
 *  - Language-specific stop word filtering
 *  - CJK bigram tokenization for phrase matching
 *  - Korean trailing particle stripping (28 particles)
 *  - Japanese script-aware segmentation (kanji/kana/ASCII)
 *  - Optional LLM-assisted expansion with graceful fallback
 *
 * @layer Domain (Memory)
 * @phase OpenClaw Extraction V3 — Sprint 2
 * @donor external/openclaw/src/memory/query-expansion.ts (807L, 0 deps)
 * @see ISessionMemoryManager for memory retrieval pipeline
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Result of FTS query expansion.
 */
export interface QueryExpansionResult {
  /** Original trimmed query */
  readonly original: string;
  /** Extracted keywords */
  readonly keywords: readonly string[];
  /** Expanded query string for FTS (original OR keywords) */
  readonly expanded: string;
}

/**
 * Optional LLM-based query expander function.
 * Can be provided to enhance keyword extraction with semantic understanding.
 */
export type LlmQueryExpander = (query: string) => Promise<string[]>;

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IQueryExpansionService {
  /**
   * Extract meaningful keywords from a conversational query.
   * Filters stop words across 8 languages, handles CJK tokenization.
   *
   * @example
   * extractKeywords("that thing we discussed about the API") → ["discussed", "api"]
   * extractKeywords("之前讨论的那个方案") → ["讨论", "方案"]
   */
  extractKeywords(query: string): string[];

  /**
   * Expand a query for FTS search.
   * Returns original query and extracted keywords for OR-matching.
   */
  expandQueryForFts(query: string): QueryExpansionResult;

  /**
   * Expand query with optional LLM assistance.
   * Falls back to local extraction if LLM is unavailable or fails.
   */
  expandQueryWithLlm(query: string, llmExpander?: LlmQueryExpander): Promise<string[]>;
}
