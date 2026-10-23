/**
 * IPromptCompressor — Domain port for prompt compression
 * @layer Domain
 *
 * Compresses retrieved context to reduce token usage while preserving
 * key information. Based on LongLLMLingua methodology.
 *
 * @see arXiv:2310.06839 — LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression
 * @see arXiv:2403.12968 — LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression
 */

import type { ScoredDocument } from './reranker-service.port';

// ─── Strategy Types ──────────────────────────────────────────────────

export type CompressionStrategy =
  | 'selective'       // Keep only high-relevance sentences
  | 'extractive'      // Extract key phrases/entities
  | 'hybrid';         // Combine selective + extractive

// ─── Configuration ───────────────────────────────────────────────────

export interface CompressionConfig {
  readonly strategy: CompressionStrategy;
  /** Target compression ratio (0–1, e.g. 0.5 = keep 50%) */
  readonly targetRatio: number;
  /** Minimum tokens per document before compression is attempted */
  readonly minTokensForCompression: number;
  /** Whether to preserve code blocks verbatim */
  readonly preserveCodeBlocks: boolean;
  /** Whether to reorder documents for position bias mitigation (LITM) */
  readonly reorderForPositionBias: boolean;
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  strategy: 'hybrid',
  targetRatio: 0.5,
  minTokensForCompression: 30,
  preserveCodeBlocks: true,
  reorderForPositionBias: true,
};

// ─── Per-Document Detail ─────────────────────────────────────────────

export interface DocumentCompressionDetail {
  readonly documentId: string;
  readonly originalTokens: number;
  readonly compressedTokens: number;
  readonly ratio: number;
  readonly skipped: boolean;
  readonly skipReason?: 'below_min_tokens' | 'code_only' | 'already_compact';
}

// ─── Result ──────────────────────────────────────────────────────────

export interface CompressionResult {
  readonly documents: readonly ScoredDocument[];
  readonly originalTokens: number;
  readonly compressedTokens: number;
  readonly actualRatio: number;
  readonly tokensSaved: number;
  readonly durationMs: number;
  readonly strategyUsed: CompressionStrategy;
  readonly documentDetails: readonly DocumentCompressionDetail[];
}

// ─── Port Interface ──────────────────────────────────────────────────

export interface IPromptCompressor {
  /**
   * Compress a set of documents to fit within a token budget.
   * Preserves key information relative to the query.
   */
  compress(
    documents: readonly ScoredDocument[],
    query: string,
    config?: Partial<CompressionConfig>,
  ): Promise<CompressionResult>;

  /**
   * Compress a single text string.
   * Returns the compressed string.
   */
  compressText(
    content: string,
    query: string,
    targetRatio: number,
  ): Promise<string>;

  /**
   * Estimate savings without actually compressing.
   */
  estimateSavings(
    documents: readonly ScoredDocument[],
    config?: Partial<CompressionConfig>,
  ): { estimatedSavings: number; originalTokens: number };

  /** Current effective configuration */
  getConfig(): CompressionConfig;

  /** Whether the compressor backend is available */
  isAvailable(): Promise<boolean>;
}
