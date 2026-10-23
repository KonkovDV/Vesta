/**
 * PromptCompressorAdapter — LongLLMLingua-style prompt compression
 * Layer: Infrastructure
 *
 * @sota-stub — Uses heuristic sentence scoring and position-bias
 *   reordering. Ready for replacement with perplexity-based model
 *   (GPT-2 or distilled scorer).
 *
 * @see arXiv:2310.06839 — LongLLMLingua
 * @see src/domain/context/prompt-compressor.port.ts — domain port
 */

import type {
  IPromptCompressor,
  CompressionConfig,
  CompressionResult,
  DocumentCompressionDetail,
} from '../../domain/context/prompt-compressor.port';
import { DEFAULT_COMPRESSION_CONFIG } from '../../domain/context/prompt-compressor.port';
import type { ScoredDocument } from '../../domain/context/reranker-service.port';

interface ILogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export class PromptCompressorAdapter implements IPromptCompressor {
  private readonly config: CompressionConfig;

  constructor(
    private readonly logger?: ILogger,
    config?: Partial<CompressionConfig>,
  ) {
    this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...config };
  }

  async compress(
    documents: readonly ScoredDocument[],
    query: string,
    config?: Partial<CompressionConfig>,
  ): Promise<CompressionResult> {
    const start = Date.now();
    const cfg = { ...this.config, ...config };

    if (documents.length === 0) {
      return {
        documents: [],
        originalTokens: 0,
        compressedTokens: 0,
        actualRatio: 1,
        tokensSaved: 0,
        durationMs: 0,
        strategyUsed: cfg.strategy,
        documentDetails: [],
      };
    }

    const originalTokens = documents.reduce((s, d) => s + d.estimatedTokens, 0);
    const compressedDocs: ScoredDocument[] = [];
    const details: DocumentCompressionDetail[] = [];

    for (const doc of documents) {
      if (doc.estimatedTokens <= cfg.minTokensForCompression) {
        compressedDocs.push(doc);
        details.push({
          documentId: doc.documentId,
          originalTokens: doc.estimatedTokens,
          compressedTokens: doc.estimatedTokens,
          ratio: 1,
          skipped: true,
          skipReason: 'below_min_tokens',
        });
        continue;
      }

      const compressed = this.compressContent(doc.content, query, cfg);
      const compTokens = this.estimateTokens(compressed);

      compressedDocs.push({
        ...doc,
        content: compressed,
        estimatedTokens: compTokens,
      });

      details.push({
        documentId: doc.documentId,
        originalTokens: doc.estimatedTokens,
        compressedTokens: compTokens,
        ratio: compTokens / doc.estimatedTokens,
        skipped: false,
      });
    }

    // Position bias reordering (Lost-in-the-Middle mitigation)
    let finalDocs = compressedDocs;
    if (cfg.reorderForPositionBias && compressedDocs.length >= 3) {
      finalDocs = this.litmReorder(compressedDocs);
    }

    const compressedTokens = finalDocs.reduce((s, d) => s + d.estimatedTokens, 0);
    const durationMs = Date.now() - start;

    this.logger?.info('prompt_compressed', {
      strategy: cfg.strategy,
      originalTokens,
      compressedTokens,
      ratio: +(compressedTokens / originalTokens).toFixed(3),
      saved: originalTokens - compressedTokens,
      durationMs,
    });

    return {
      documents: finalDocs,
      originalTokens,
      compressedTokens,
      actualRatio: originalTokens > 0 ? compressedTokens / originalTokens : 1,
      tokensSaved: originalTokens - compressedTokens,
      durationMs,
      strategyUsed: cfg.strategy,
      documentDetails: details,
    };
  }

  async compressText(
    content: string,
    query: string,
    targetRatio: number,
  ): Promise<string> {
    return this.compressContent(content, query, { ...this.config, targetRatio });
  }

  estimateSavings(
    documents: readonly ScoredDocument[],
    config?: Partial<CompressionConfig>,
  ): { estimatedSavings: number; originalTokens: number } {
    const cfg = { ...this.config, ...config };
    const originalTokens = documents.reduce((s, d) => s + d.estimatedTokens, 0);

    let estimated = 0;
    for (const doc of documents) {
      if (doc.estimatedTokens <= cfg.minTokensForCompression) {
        estimated += doc.estimatedTokens;
      } else {
        estimated += Math.ceil(doc.estimatedTokens * cfg.targetRatio);
      }
    }

    return { originalTokens, estimatedSavings: originalTokens - estimated };
  }

  getConfig(): CompressionConfig {
    return { ...this.config };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  // ─── Private ───────────────────────────────────────────────────────

  private compressContent(content: string, query: string, cfg: CompressionConfig): string {
    switch (cfg.strategy) {
      case 'selective':
        return this.selectiveCompress(content, query, cfg);
      case 'extractive':
        return this.extractiveCompress(content, query, cfg);
      case 'hybrid':
      default:
        return this.hybridCompress(content, query, cfg);
    }
  }

  /**
   * Selective: keep only sentences that overlap with query terms.
   */
  private selectiveCompress(content: string, query: string, cfg: CompressionConfig): string {
    const preserved = cfg.preserveCodeBlocks ? this.extractCodeBlocks(content) : [];
    const textOnly = cfg.preserveCodeBlocks ? this.removeCodeBlocks(content) : content;

    const sentences = this.splitSentences(textOnly);
    const queryTerms = new Set(this.tokenize(query));

    const scored = sentences.map((s, idx) => {
      const terms = this.tokenize(s);
      const overlap = terms.filter(t => queryTerms.has(t)).length / (terms.length || 1);
      const posBonus = 1 - (idx / sentences.length) * 0.3;
      return { s, score: overlap * 0.6 + posBonus * 0.4 };
    });

    scored.sort((a, b) => b.score - a.score);

    const budget = this.estimateTokens(content) * cfg.targetRatio;
    const preservedTokens = preserved.reduce((s, p) => s + this.estimateTokens(p), 0);
    const remaining = Math.max(0, budget - preservedTokens);

    const selected: string[] = [];
    let used = 0;
    for (const { s } of scored) {
      const t = this.estimateTokens(s);
      if (used + t <= remaining) {
        selected.push(s);
        used += t;
      }
    }

    // Restore original order
    const selectedSet = new Set(selected);
    const ordered = sentences.filter(s => selectedSet.has(s));

    return [...preserved, ...ordered].join('\n');
  }

  /**
   * Extractive: extract key terms and phrases related to query.
   */
  private extractiveCompress(content: string, query: string, cfg: CompressionConfig): string {
    const preserved = cfg.preserveCodeBlocks ? this.extractCodeBlocks(content) : [];
    const textOnly = cfg.preserveCodeBlocks ? this.removeCodeBlocks(content) : content;

    const queryTerms = new Set(this.tokenize(query));
    const sentences = this.splitSentences(textOnly);

    // Keep sentences that contain at least one query term
    const relevant = sentences.filter(s => {
      const terms = this.tokenize(s);
      return terms.some(t => queryTerms.has(t));
    });

    // If too much, trim to budget
    const budget = this.estimateTokens(content) * cfg.targetRatio;
    const preservedTokens = preserved.reduce((s, p) => s + this.estimateTokens(p), 0);
    const remaining = Math.max(0, budget - preservedTokens);

    const trimmed: string[] = [];
    let used = 0;
    for (const s of relevant) {
      const t = this.estimateTokens(s);
      if (used + t <= remaining) {
        trimmed.push(s);
        used += t;
      }
    }

    return [...preserved, ...trimmed].join('\n');
  }

  /**
   * Hybrid: combine selective (scored) + extractive (term match).
   * Uses the better result.  
   */
  private hybridCompress(content: string, query: string, cfg: CompressionConfig): string {
    const selective = this.selectiveCompress(content, query, cfg);
    const extractive = this.extractiveCompress(content, query, cfg);

    // Pick the one that preserves more information (more tokens within budget)
    const sTokens = this.estimateTokens(selective);
    const eTokens = this.estimateTokens(extractive);
    return sTokens >= eTokens ? selective : extractive;
  }

  /**
   * Lost-in-the-Middle reordering:
   * Place highest-relevance docs at head and tail, lowest in middle.
   * @see arXiv:2307.03172 — Lost in the Middle
   */
  private litmReorder(docs: ScoredDocument[]): ScoredDocument[] {
    const sorted = [...docs].sort((a, b) => b.rerankScore - a.rerankScore);
    const result: ScoredDocument[] = [];
    let left = true;

    for (const doc of sorted) {
      if (left) {
        result.push(doc);
      } else {
        result.splice(Math.floor(result.length / 2), 0, doc);
      }
      left = !left;
    }

    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  }

  private estimateTokens(text: string): number {
    // Rough 4-chars-per-token estimate (sufficient for stub)
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private splitSentences(text: string): string[] {
    return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  }

  private extractCodeBlocks(content: string): string[] {
    return content.match(/```[\s\S]*?```/g) ?? [];
  }

  private removeCodeBlocks(content: string): string {
    return content.replace(/```[\s\S]*?```/g, '').trim();
  }
}
