/**
 * ToolResultSummarizerAdapter — Infrastructure adapter for IToolResultSummarizer.
 *
 * Summarizes large tool outputs (> threshold tokens) using LLM to fit within
 * context window budget. Outputs below threshold are passed through unchanged.
 *
 * Token estimation uses a simple heuristic (~4 chars per token) for fast checks.
 * Actual summarization is performed via ILLMAdapterFactory.
 *
 * Best Practices Applied (March 2026):
 * - temperature 0.2 for faithful summarization (minimal creativity)
 * - maxTokens capped at maxOutputTokens from request
 * - correlationId in all log entries (Hard Rule #6)
 *
 * DI: constructor(llmFactory, logger) — 2 args
 *
 * @layer Infrastructure (implements Domain port)
 * @see IToolResultSummarizer (src/domain/agents/tool-result-summarizer.interface.ts)
 * @see Book Ch.5 "Tool Use" — Tool Output Trimmer
 * @see OpenAI Agents SDK "ToolOutputTrimmer" pattern
 */

import type {
  IToolResultSummarizer,
  ToolResultSummaryRequest,
  ToolResultSummaryResult,
} from '../../domain/agents/tool-result-summarizer.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

/** Approximate chars per token for estimation (~4 for English, conservative) */
const CHARS_PER_TOKEN = 4;

/** Default token threshold for summarization */
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

/** System prompt for summarization */
const SUMMARIZATION_PROMPT =
  'You are a concise summarizer. Summarize the following tool output, ' +
  'preserving key facts, numbers, and actionable information. ' +
  'Remove redundant details and formatting.';

export class ToolResultSummarizerAdapter implements IToolResultSummarizer {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly logger: ILogger,
  ) {}

  async summarize(
    request: ToolResultSummaryRequest,
    correlationId: CorrelationId,
  ): Promise<ToolResultSummaryResult> {
    const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const originalTokenCount = this.estimateTokens(request.rawOutput);

    // Under threshold — pass through
    if (originalTokenCount <= maxTokens) {
      return {
        summarized: false,
        output: request.rawOutput,
        originalTokenCount,
        summarizedTokenCount: originalTokenCount,
      };
    }

    this.logger.info('Summarizing large tool output', {
      correlationId,
      toolName: request.toolName,
      originalTokenCount,
      maxTokens,
    });

    try {
      const { adapter } = await this.llmFactory.createAdapterWithFailover();

      const result = await adapter.generateText(
        `${SUMMARIZATION_PROMPT}\n\n--- TOOL OUTPUT (${request.toolName}) ---\n${request.rawOutput}`,
        {
          temperature: 0.2,
          maxTokens,
        },
      );

      const summarizedTokenCount = this.estimateTokens(result.text);

      this.logger.info('Tool output summarized', {
        correlationId,
        toolName: request.toolName,
        originalTokenCount,
        summarizedTokenCount,
        reductionPercent: Math.round((1 - summarizedTokenCount / originalTokenCount) * 100),
      });

      return {
        summarized: true,
        output: result.text,
        originalTokenCount,
        summarizedTokenCount,
      };
    } catch (error) {
      // On LLM failure, truncate rather than fail
      this.logger.warn('Summarization failed, falling back to truncation', {
        correlationId,
        toolName: request.toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      const truncated = request.rawOutput.slice(0, maxTokens * CHARS_PER_TOKEN);
      return {
        summarized: true,
        output: truncated + '\n[...truncated]',
        originalTokenCount,
        summarizedTokenCount: this.estimateTokens(truncated),
      };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
