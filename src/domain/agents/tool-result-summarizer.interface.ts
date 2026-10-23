/**
 * IToolResultSummarizer — Domain interface for tool output summarization.
 *
 * Summarizes or truncates large tool outputs to fit within context window budget.
 * Used by IPromptChainExecutor before passing tool results to the next chain step.
 * Inspired by OpenAI Agents SDK "ToolOutputTrimmer" pattern.
 *
 * Threshold: tool results > 4000 tokens are summarized via LLM; smaller results
 * are passed through unchanged.
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.5 "Tool Use" — Tool Output Trimmer
 * @see OpenAI Agents SDK "ToolOutputTrimmer" pattern
 */

import type { CorrelationId } from '@/ai-types';

/**
 * Request to summarize a tool's output.
 */
export interface ToolResultSummaryRequest {
  readonly toolName: string;
  readonly rawOutput: string;
  /** Maximum token count for the summarized output (default: 4000). */
  readonly maxOutputTokens?: number;
}

/**
 * Result of tool output summarization.
 */
export interface ToolResultSummaryResult {
  /** Whether summarization was actually performed (false if under threshold). */
  readonly summarized: boolean;
  /** Summarized or original output. */
  readonly output: string;
  /** Estimated token count of the original output. */
  readonly originalTokenCount: number;
  /** Estimated token count of the summarized output. */
  readonly summarizedTokenCount: number;
}

/**
 * Tool result summarizer for context window management.
 * Lifecycle: singleton.
 */
export interface IToolResultSummarizer {
  /** Summarize a tool output if it exceeds the token threshold. */
  summarize(
    request: ToolResultSummaryRequest,
    correlationId: CorrelationId,
  ): Promise<ToolResultSummaryResult>;
}
