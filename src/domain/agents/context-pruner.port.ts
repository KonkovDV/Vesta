/**
 * Context Pruner — Domain port (interface).
 *
 * Prunes agentic context messages to fit within the model's context window.
 * Uses a two-phase strategy: soft trim (head+tail) then hard clear.
 *
 * @layer Domain (Agents)
 * @phase OpenClaw Extraction V4 — Sprint 2
 * @donor external/openclaw/src/agents/pi-extensions/context-pruning/pruner.ts (9.3KB)
 * @tier Tier 2 (ADAPT) — context estimation + soft/hard pruning
 * @owasp Agentic Top 10 2026: Context Window Overflow
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A content block (text or image) in a message.
 */
export interface ContentBlock {
  readonly type: 'text' | 'image' | 'thinking' | 'toolCall';
  readonly text?: string;
  readonly thinking?: string;
  readonly arguments?: unknown;
}

/**
 * A generalized agentic message with role and content.
 */
export interface AgenticMessage {
  readonly role: 'user' | 'assistant' | 'toolResult' | 'system';
  readonly content: string | readonly ContentBlock[];
  readonly toolName?: string;
  readonly [key: string]: unknown;
}

/**
 * Pruning configuration for soft trim and hard clear phases.
 */
export interface ContextPruningSettings {
  /** Ratio of context window usage to trigger soft trim. Default: 0.8 */
  readonly softTrimRatio: number;
  /** Ratio of context window usage to trigger hard clear. Default: 1.0 */
  readonly hardClearRatio: number;
  /** Number of most recent assistant messages to protect from pruning. Default: 3 */
  readonly keepLastAssistants: number;
  /** Minimum prunable tool chars before hard clear is attempted. Default: 5000 */
  readonly minPrunableToolChars: number;
  /** Soft trim configuration. */
  readonly softTrim: {
    readonly maxChars: number;
    readonly headChars: number;
    readonly tailChars: number;
  };
  /** Hard clear configuration. */
  readonly hardClear: {
    readonly enabled: boolean;
    readonly placeholder: string;
  };
  /** Tool names eligible for pruning ('all' or specific list). */
  readonly tools: 'all' | readonly string[];
}

/**
 * Default pruning settings.
 */
export const DEFAULT_PRUNING_SETTINGS: ContextPruningSettings = {
  softTrimRatio: 0.8,
  hardClearRatio: 1.0,
  keepLastAssistants: 3,
  minPrunableToolChars: 5_000,
  softTrim: {
    maxChars: 10_000,
    headChars: 3_000,
    tailChars: 1_000,
  },
  hardClear: {
    enabled: true,
    placeholder: '[Tool result pruned to save context window space.]',
  },
  tools: 'all',
};

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * IContextPruner — prunes agentic message context to fit within model limits.
 */
export interface IContextPruner {
  /**
   * Prune context messages using soft trim then hard clear.
   * Returns a new array (does not mutate the original).
   *
   * @param messages - Conversation messages
   * @param contextWindowTokens - Model's total context window size in tokens
   * @param settings - Pruning configuration (optional, uses defaults)
   * @param isToolPrunable - Optional predicate for tool-name eligibility
   * @returns Pruned messages array
   */
  pruneContextMessages(
    messages: AgenticMessage[],
    contextWindowTokens: number,
    settings?: Partial<ContextPruningSettings>,
    isToolPrunable?: (toolName: string) => boolean,
  ): AgenticMessage[];

  /**
   * Estimate the total character count across all messages.
   */
  estimateContextChars(messages: AgenticMessage[]): number;
}
