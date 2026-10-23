/**
 * IJITContextInjector — Domain port for file-aware bug context injection.
 *
 * When a developer or AI agent begins editing a file, this service
 * queries the error graph (IErrorGraphRepository) for relevant known bugs
 * and injects them as contextual rules into the system prompt or MCP context.
 *
 * Flow: File edit detected → queryByContext() → format as @context rules → inject
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @vector V5: Predictive Auto-Traps (GraphRAG KNOWN_BUGS)
 * @horizon Q3 2026
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §6
 * @see IErrorGraphRepository — error data source
 * @see MicroPhoenixMcpServer — MCP integration point
 */

import type { CorrelationId } from '@/ai-types';

// ── Types ─────────────────────────────────────────────────────────

/** A contextual rule injected based on known bugs for a file. */
export interface InjectedContextRule {
  /** Source error ID (e.g. "SNG-001"). */
  readonly errorId: string;
  /** Compact rule text suitable for system prompt injection. */
  readonly ruleText: string;
  /** Relevance score (0.0–1.0). */
  readonly relevance: number;
  /** Category tag for grouping in context. */
  readonly category: string;
}

/** Result of JIT context injection for a file. */
export interface JITContextResult {
  /** The file for which context was generated. */
  readonly filePath: string;
  /** Injected rules, ordered by relevance (descending). */
  readonly rules: readonly InjectedContextRule[];
  /** Estimated token count of all injected rules. */
  readonly tokenCount: number;
  /** Whether the result was served from cache. */
  readonly cached: boolean;
}

// ── Port ──────────────────────────────────────────────────────────

/**
 * Provides JIT (Just-In-Time) context injection of relevant known bugs
 * when a file is being edited.
 */
export interface IJITContextInjector {
  /**
   * Get contextual bug rules relevant to the given file.
   * Results are bounded by token budget to avoid context overflow.
   *
   * @param filePath Workspace-relative path of the file being edited.
   * @param maxTokens Maximum token budget for injected context. Default: 500.
   * @param correlationId Request correlation ID.
   */
  getContextForFile(
    filePath: string,
    maxTokens: number,
    correlationId: CorrelationId,
  ): Promise<JITContextResult>;

  /**
   * Invalidate cached context for a file (e.g. after a new bug is ingested).
   */
  invalidateCache(filePath: string): void;
}
