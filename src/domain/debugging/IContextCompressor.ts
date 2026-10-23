/**
 * IContextCompressor — Domain port for cognitive context compression.
 *
 * Instead of sending raw historical bug texts to the AI agent,
 * this service distills N found bugs into a concise "Code Correction
 * Principle" — a 3-line concentrate of actionable wisdom.
 *
 * Solves the "Lost in the Middle" attention degradation problem
 * (see LLMLingua / Contextual Compression, SOTA 2026).
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @vector V5: Cognitive Context Compression
 * @horizon Q3 2026
 * @see PLANS/SOTA_BUG_CATCHING_2026/ — academic specifications
 * @see JITContextInjectorAdapter — consumer of compressed context
 */

import type { CorrelationId } from '@/ai-types';
import type { InjectedContextRule } from './IJITContextInjector';

// ── Types ─────────────────────────────────────────────────────────

/** Input for context compression. */
export interface CompressionInput {
  /** Raw rules to compress. */
  readonly rules: readonly InjectedContextRule[];
  /** Maximum output tokens for the compressed principle. */
  readonly maxOutputTokens: number;
  /** File being edited (for context-aware compression). */
  readonly filePath: string;
}

/** Result of context compression. */
export interface CompressedContext {
  /** The distilled principle (3-line concentrate). */
  readonly principle: string;
  /** Number of source rules that were compressed. */
  readonly sourceRuleCount: number;
  /** Estimated token count of the compressed output. */
  readonly tokenCount: number;
  /** Compression ratio (input tokens / output tokens). */
  readonly compressionRatio: number;
}

// ── Port ──────────────────────────────────────────────────────────

export interface IContextCompressor {
  /**
   * Compress multiple raw bug rules into a concise principle.
   * Uses information-theoretic compression to preserve signal, discard noise.
   */
  compress(
    input: CompressionInput,
    correlationId: CorrelationId,
  ): Promise<CompressedContext>;
}
