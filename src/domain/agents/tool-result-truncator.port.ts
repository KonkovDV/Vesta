/**
 * Tool Result Truncator — Domain port (interface).
 *
 * Provides smart truncation of oversized tool results to fit within
 * an LLM's context window. Uses head+tail strategy when error/summary
 * content is detected near the end of output.
 *
 * @layer Domain (Agents)
 * @phase OpenClaw Extraction V4 — Sprint 2
 * @donor external/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts (13.8KB)
 * @tier Tier 1 (AS-IS) — self-contained, 1 dep (logger only)
 * @owasp Agentic Top 10 2026: Context Window Overflow, Resource Exhaustion
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A content block in a tool result message.
 */
export interface ToolResultContentBlock {
  readonly type: 'text' | 'image';
  readonly text?: string;
}

/**
 * A tool result message with typed content blocks.
 */
export interface ToolResultMessage {
  readonly role: 'toolResult';
  readonly content: readonly ToolResultContentBlock[];
  readonly [key: string]: unknown;
}

/**
 * Options for truncation behavior.
 */
export interface ToolResultTruncationOptions {
  /** Custom suffix appended to truncated text. */
  readonly suffix?: string;
  /** Minimum characters to preserve when truncating. */
  readonly minKeepChars?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum share of context window a single tool result should occupy. */
export const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/** Hard character limit for a single tool result text block. */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

/** Default minimum characters to keep when truncating. */
export const DEFAULT_MIN_KEEP_CHARS = 2_000;

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * IToolResultTruncator — truncates oversized tool results to fit within
 * model context windows while preserving error/summary content at the tail.
 */
export interface IToolResultTruncator {
  /**
   * Truncate a single text string to fit within maxChars.
   * Uses head+tail strategy when tail contains important content.
   */
  truncateToolResultText(
    text: string,
    maxChars: number,
    options?: ToolResultTruncationOptions,
  ): string;

  /**
   * Calculate the maximum allowed characters for a single tool result
   * based on the model's context window tokens.
   */
  calculateMaxToolResultChars(contextWindowTokens: number): number;

  /**
   * Get total character count of text content blocks in a tool result message.
   */
  getToolResultTextLength(msg: ToolResultMessage): number;

  /**
   * Truncate a tool result message's text content blocks to fit within maxChars.
   * Returns a new message (does not mutate the original).
   */
  truncateToolResultMessage(
    msg: ToolResultMessage,
    maxChars: number,
    options?: ToolResultTruncationOptions,
  ): ToolResultMessage;
}
