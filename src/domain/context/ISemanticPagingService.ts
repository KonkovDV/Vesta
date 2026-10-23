/**
 * ISemanticPagingService — Domain port for Semantic Memory Management Unit (S-MMU)
 * Layer: Domain (port / contract)
 *
 * Defines the contract for paging through multi-tier semantic memory.
 * Instead of dumping the entire context into a single prompt, agents
 * request "pages" of relevant context from 3 memory tiers:
 *
 *   Tier 1 — Main Context: Local structured data (.mdc chunks, project docs)
 *   Tier 2 — Core/Recall: Event-sourced history (IEventStore, PQC-enriched)
 *   Tier 3 — Archival: Long-term vector search (embeddings, mem0)
 *   Tier 4 — Knowledge Graph: AST-driven graph traversal (GraphRAG, Phase 5.5)
 *
 * The S-MMU aggregates and ranks results across tiers, returning a
 * bounded "page" that fits within the agent's context window budget.
 *
 * Implementation resides in Application (orchestrator) + Infrastructure
 * (tier adapters). Resolution via DI:
 *   container.resolve<ISemanticPagingService>(DI_TOKENS.ISemanticPagingService)
 *
 * @Horizon 2 — Federation & Intelligence (Context Engineering)
 * @see Context Engineering Strategy 2026
 * @see src/domain/events/event-store.interface.ts — Tier 2 data source
 */

// ─── Value Types ──────────────────────────────────────────────────────

/** Memory tier identifier */
export type MemoryTier = 'main_context' | 'core_recall' | 'archival' | 'knowledge_graph';

export interface IMainContextProvider {
  search(query: string, maxResults: number): Promise<ReadonlyArray<{
    content: string;
    source: string;
    score: number;
    tokens: number;
  }>>;
  getItemCount(): Promise<number>;
}

export interface IGraphContextProvider {
  search(query: string, maxResults: number): Promise<ReadonlyArray<{
    content: string;
    source: string;
    score: number;
    tokens: number;
  }>>;
  getNodeCount(): Promise<number>;
}

/** A single chunk of context returned by the S-MMU */
export interface SemanticPage {
  /** Unique page identifier */
  readonly pageId: string;
  /** Source tier that produced this page */
  readonly tier: MemoryTier;
  /** Relevance score (0.0 - 1.0) from ranking/embedding similarity */
  readonly relevanceScore: number;
  /** The actual content text */
  readonly content: string;
  /** Source reference (file path, event ID, memory key, etc.) */
  readonly source: string;
  /** Token count estimate for this page */
  readonly estimatedTokens: number;
  /** ISO timestamp of when the source was last updated */
  readonly updatedAt: string;
  /** Optional metadata (PQC signature info, event type, etc.) */
  readonly metadata?: Record<string, unknown>;
}

/** Request for a semantic page of context */
export interface SemanticPagingRequest {
  /** Natural language query to match context against */
  readonly query: string;
  /** Maximum number of pages to return (default: 5) */
  readonly maxPages?: number;
  /** Maximum total estimated tokens across all returned pages (default: 4096) */
  readonly tokenBudget?: number;
  /** Model identifier for dynamic token budget calculation (e.g., 'gpt-4', 'claude-3-opus') */
  readonly model?: string;
  /** Restrict to specific tiers (default: all tiers) */
  readonly tiers?: readonly MemoryTier[];
  /** Tenant ID for multi-tenant isolation */
  readonly tenantId?: string;
  /** Session ID for session-scoped recall */
  readonly sessionId?: string;
  /** Correlation ID for observability */
  readonly correlationId?: string;
}

/**
 * Cache control hint for API adapters (Anthropic cache_control, OpenAI equivalent).
 * Prefix pages are immutable per session and can be marked ephemeral for prompt caching.
 *
 * @pattern SPI (Semantic Prefix Isolation) — SOTA 2026 Context Engineering
 * @see Anthropic (2025) "Prompt Caching with cache_control"
 */
export type CacheHint = 'ephemeral' | 'none';

/**
 * ContextFrame — separates immutable prefix from dynamic context.
 *
 * The prefix contains system instructions, MDC rules, and project structure
 * that rarely change within a session. LLM API adapters can apply
 * cache_control: { type: "ephemeral" } to prefix pages for up to 90% cost
 * reduction on repeated calls.
 *
 * @pattern SPI (Semantic Prefix Isolation)
 * @see Anthropic (2025) cache_control specification
 */
export interface ContextFrame {
  /** Immutable pages (MDC rules, project structure, system instructions) — cacheable */
  readonly prefix: readonly SemanticPage[];
  /** Dynamic pages (event history, archival retrieval, graph traversal) — per-query */
  readonly dynamic: readonly SemanticPage[];
  /** Total tokens in prefix */
  readonly prefixTokens: number;
  /** Total tokens in dynamic */
  readonly dynamicTokens: number;
}

/**
 * Compressive summary of truncated pages.
 *
 * When the token budget is exhausted, instead of silently dropping remaining
 * pages (VEC-002: Information Drop-off), S-MMU generates a lightweight
 * summary preserving source references. This enables the model to request
 * deeper retrieval on specific sources if needed.
 *
 * @pattern Compressive Truncation — SOTA 2026 Context Engineering
 * @see Munkhdalai et al. (2024) arXiv:2404.07143 "Infini-attention" compressive memory
 */
export interface TruncationSummary {
  /** Condensed summary of all dropped pages */
  readonly summary: string;
  /** Number of pages that were dropped */
  readonly droppedCount: number;
  /** Total tokens in dropped pages */
  readonly droppedTokens: number;
  /** Source references from dropped pages for potential follow-up queries */
  readonly sources: readonly string[];
}

/** Result of a semantic paging operation */
export interface SemanticPagingResult {
  /** Retrieved pages, ranked by relevance */
  readonly pages: readonly SemanticPage[];
  /** Total estimated tokens across all returned pages */
  readonly totalEstimatedTokens: number;
  /** Number of tiers that contributed results */
  readonly tiersQueried: number;
  /** Tiers that returned zero results */
  readonly emptyTiers: readonly MemoryTier[];
  /** Processing duration in milliseconds */
  readonly durationMs: number;
  /** Whether results were truncated due to tokenBudget */
  readonly truncated: boolean;
  /**
   * SPI: Structured context frame separating cacheable prefix from dynamic content.
   * When present, API adapters should apply cache_control to prefix pages.
   * When absent, all pages are treated as dynamic (backward compatible).
   *
   * @pattern SPI (Semantic Prefix Isolation)
   */
  readonly contextFrame?: ContextFrame;
  /**
   * VEC-002: Compressive summary of pages that were dropped due to token budget.
   * Present only when `truncated === true`. Allows the model to see what was
   * excluded and request targeted follow-up.
   *
   * @pattern Compressive Truncation
   */
  readonly truncationSummary?: TruncationSummary;
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for semantic context paging across multi-tier memory.
 *
 * Domain/Application layers consume this interface; tier adapters live
 * in Infrastructure and are composed by the Application-layer service.
 */
export interface ISemanticPagingService {
  /**
   * Retrieve a page of semantically relevant context.
   *
   * Queries all requested tiers in parallel, merges and ranks results
   * by relevance, and trims to the token budget.
   *
   * @param request — paging request with query, budget, and tier filters
   * @returns Ranked pages within the token budget
   */
  getPage(request: SemanticPagingRequest): Promise<SemanticPagingResult>;

  /**
   * List available memory tiers and their health status.
   */
  listTiers(): Promise<ReadonlyArray<{ tier: MemoryTier; available: boolean; itemCount: number }>>;

  /**
   * Invalidate the semantic cache.
   *
   * Call when underlying data sources change (new events, new chunks,
   * new embeddings) to prevent serving stale cached results.
   * Implementations should clear all cached entries and bump an
   * internal generation counter so in-flight reads are also rejected.
   */
  invalidateCache(): void;
}
