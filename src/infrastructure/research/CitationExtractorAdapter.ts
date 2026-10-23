/**
 * CitationExtractorAdapter — Infrastructure Adapter
 *
 * Extracts citations from text by pattern-matching source references.
 * Uses heuristic matching (title/snippet substring) — no LLM call needed.
 *
 * Best Practices Applied (March 2026):
 * - Heuristic-first evaluation (like OpenEvolve cascade: quick → expensive)
 * - Source provenance tracking via sourceIndex
 * - O(n*m) complexity where n=text-sentences, m=sources (acceptable for <= 20 sources)
 *
 * DI: constructor(logger: ILogger) — 1 arg
 *
 * @see Book Ch.6 — Citation Annotation Extractor
 */

import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ICitationExtractor } from '../../domain/research/citation-extractor.interface';
import type { Citation, ResearchSource } from '../../domain/research/deep-research.interface';

/** Minimum word overlap to consider a citation match */
const MIN_OVERLAP_RATIO = 0.3;

export class CitationExtractorAdapter implements ICitationExtractor {
  constructor(
    private readonly logger: ILogger,
  ) {}

  async extract(
    text: string,
    sources: readonly ResearchSource[],
    correlationId: CorrelationId,
  ): Promise<readonly Citation[]> {
    this.logger.info('CitationExtractorAdapter.extract', {
      correlationId,
      textLength: text.length,
      sourceCount: sources.length,
    });

    const citations: Citation[] = [];

    // 1. Check for explicit [N] references
    const explicitCitations = this.extractExplicitCitations(text, sources);
    citations.push(...explicitCitations);

    // 2. Heuristic: find sentences that reference source titles/snippets
    const heuristicCitations = this.extractHeuristicCitations(text, sources);

    // Deduplicate: don't add heuristic citations if explicit ones cover the same source
    const explicitSourceIndices = new Set(citations.map((c) => c.sourceIndex));
    for (const hc of heuristicCitations) {
      if (!explicitSourceIndices.has(hc.sourceIndex)) {
        citations.push(hc);
      }
    }

    this.logger.info('CitationExtractorAdapter.extracted', {
      correlationId,
      totalCitations: citations.length,
      explicit: explicitCitations.length,
      heuristic: heuristicCitations.length,
    });

    return citations;
  }

  /** Extract [N] style explicit citations */
  private extractExplicitCitations(
    text: string,
    sources: readonly ResearchSource[],
  ): Citation[] {
    const citations: Citation[] = [];
    const regex = /\[(\d+)\]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const sourceIndex = parseInt(match[1], 10) - 1;
      if (sourceIndex >= 0 && sourceIndex < sources.length) {
        const start = Math.max(0, match.index - 60);
        const end = Math.min(text.length, match.index + match[0].length + 60);
        citations.push({
          text: text.substring(start, end).trim(),
          sourceIndex,
        });
      }
    }

    return citations;
  }

  /** Extract citations by matching source title/snippet words against text sentences */
  private extractHeuristicCitations(
    text: string,
    sources: readonly ResearchSource[],
  ): Citation[] {
    const citations: Citation[] = [];
    const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 10);

    for (const [idx, source] of sources.entries()) {
      const sourceWords = this.tokenize(source.title + ' ' + source.snippet);
      if (sourceWords.length === 0) continue;

      for (const sentence of sentences) {
        const sentenceWords = this.tokenize(sentence);
        const overlap = sentenceWords.filter((w) => sourceWords.includes(w)).length;
        const overlapRatio = overlap / sourceWords.length;

        if (overlapRatio >= MIN_OVERLAP_RATIO) {
          citations.push({
            text: sentence,
            sourceIndex: idx,
          });
          break; // One citation per source via heuristic
        }
      }
    }

    return citations;
  }

  /** Tokenize text into lowercase words, filtering short/common words */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length > 3);
  }
}
