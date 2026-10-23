/**
 * IAdaptiveMemoryRetrieval — Domain port for context-aware tip retrieval at task start.
 *
 * CC-036 Adaptive Memory Retrieval System: the fourth and final component of the
 * Trajectory-Informed Memory pipeline. Retrieves relevant tips from the accumulated
 * tip database and injects them into agent prompts before reasoning begins.
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-036 Adaptive Memory Retrieval (TIM arXiv:2603.10600 §3.3)
 * @see src/domain/memory/IContextualTipGenerator.ts — CC-035 upstream tip source
 */

import type { StructuredTip, TipCategory } from './IContextualTipGenerator';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Retrieval strategy — how tips are matched to the current task.
 */
export type RetrievalStrategy = 'keyword_similarity' | 'llm_guided';

/** A scored tip with relevance information. */
export interface ScoredTip {
  /** The tip itself. */
  readonly tip: StructuredTip;
  /** Relevance score (0.0-1.0). */
  readonly relevanceScore: number;
  /** Why this tip was selected. */
  readonly matchReason: string;
}

/** Result of a tip retrieval operation. */
export interface TipRetrievalResult {
  /** Task description that was queried. */
  readonly taskDescription: string;
  /** Matched tips, sorted by relevance (highest first). */
  readonly tips: readonly ScoredTip[];
  /** Retrieval strategy used. */
  readonly strategyUsed: RetrievalStrategy;
  /** Total tips in the store that were searched. */
  readonly totalTipsSearched: number;
  /** Retrieval timestamp. */
  readonly retrievedAt: string;
}

/** Source classification for injected runtime guidance. */
export type InjectedTipSourceKind = 'tip' | 'principle';

/** Normalized descriptor for an injected guidance item. */
export interface InjectedTipDescriptor {
  /** Stable injected tip identity. */
  readonly tipId: string;
  /** Source kind for operator visibility and feedback routing. */
  readonly sourceKind: InjectedTipSourceKind;
  /** Tip category carried into retrieval. */
  readonly category: TipCategory;
}

/** Formatted context injection for agent prompts. */
export interface TipInjectionResult {
  /** Formatted guidelines section to inject into the prompt. */
  readonly guidelinesSection: string;
  /** Number of tips injected. */
  readonly tipsInjected: number;
  /** Categories represented. */
  readonly categoriesRepresented: readonly TipCategory[];
  /** Injected tip identities for downstream feedback and operator visibility. */
  readonly tipIds?: readonly string[];
  /** Normalized descriptors for injected guidance items. */
  readonly injectedTips?: readonly InjectedTipDescriptor[];
}

/** Configuration for tip retrieval. */
export interface TipRetrievalConfig {
  /** Retrieval strategy. Default: 'keyword_similarity'. */
  readonly strategy: RetrievalStrategy;
  /** Minimum similarity score for inclusion (0.0-1.0). Default: 0.3. */
  readonly similarityThreshold: number;
  /** Maximum tips to retrieve. Default: 5. */
  readonly topK: number;
  /** Filter by tip categories. Default: all categories. */
  readonly categoryFilter?: readonly TipCategory[];
  /** Filter by task domain. Default: no filtering. */
  readonly domainFilter?: string;
  /** Whether to include priority weighting. Default: true. */
  readonly priorityWeighting: boolean;
}

/** Default retrieval configuration. */
export const DEFAULT_RETRIEVAL_CONFIG: TipRetrievalConfig = {
  strategy: 'keyword_similarity',
  similarityThreshold: 0.3,
  topK: 5,
  priorityWeighting: true,
};

/** Retrieval statistics. */
export interface RetrievalStats {
  /** Total retrievals performed. */
  readonly totalRetrievals: number;
  /** Average tips returned per retrieval. */
  readonly avgTipsReturned: number;
  /** Average relevance score of returned tips. */
  readonly avgRelevanceScore: number;
  /** Most frequently retrieved tip categories. */
  readonly topCategories: readonly TipCategory[];
}

export interface TipUsageAudit {
  readonly totalFeedback: number;
  readonly usedCount: number;
  readonly helpfulCount: number;
  readonly helpfulRate: number;
  readonly unhelpfulTipIds: readonly string[];
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Adaptive Memory Retrieval — retrieves relevant tips from the accumulated
 * tip database and injects them into agent prompts at task start.
 */
export interface IAdaptiveMemoryRetrieval {
  /**
   * Retrieve relevant tips for a task description.
   */
  retrieveRelevantTips(
    taskDescription: string,
    tips: readonly StructuredTip[],
    config?: TipRetrievalConfig,
  ): TipRetrievalResult;

  /**
   * Format retrieved tips for injection into an agent prompt.
   */
  formatForInjection(
    retrievalResult: TipRetrievalResult,
  ): TipInjectionResult;

  /**
   * Convenience: retrieve + format in one call.
   */
  retrieveAndInject(
    taskDescription: string,
    tips: readonly StructuredTip[],
    config?: TipRetrievalConfig,
  ): TipInjectionResult;

  /**
   * Get retrieval statistics.
   */
  getStats(): RetrievalStats;

  /** Record whether an injected tip was used and whether it helped. */
  recordTipFeedback?(tipId: string, used: boolean, helpful: boolean): void;

  /** Return the current usage/helpfulness audit for injected tips. */
  getUsageAudit?(): TipUsageAudit;

  /** Reset all state. */
  reset(): void;

  /**
   * Optional readiness barrier for adapters that hydrate persisted tip caches at startup.
   * Consumers relying on durable cross-session tips can await this hook deterministically.
   */
  whenReady?(): Promise<void>;
}
