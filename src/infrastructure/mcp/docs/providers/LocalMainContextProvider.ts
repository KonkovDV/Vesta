/**
 * LocalMainContextProvider — IMainContextProvider adapter for local documentation.
 *
 * Layer: Infrastructure (dev-time)
 *
 * Wraps existing loaders (ContextIndexLoader, MdcChunker, AI_CHEATSHEET, etc.)
 * to implement the IMainContextProvider interface for SemanticPagingService Tier 1.
 *
 * Since the MCP Docs Server runs as a standalone stdio process (no DB, no DI),
 * this provider operates entirely on local file data loaded at startup.
 *
 * @Horizon 2 — Context Engineering: S-MMU Tier 1 Provider
 * @see src/application/services/context/SemanticPagingService.ts — consumer
 * @see src/infrastructure/mcp/context/loaders/ContextIndexLoader.ts — data source
 * @see src/infrastructure/mcp/context/parsers/MdcChunker.ts — hierarchical chunks
 */

import type { IMainContextProvider } from '../../../../domain/context/ISemanticPagingService';
import type { MdcChunk } from '../../context/parsers/MdcChunker';
import type { ContextIndex } from '../../context/loaders/ContextIndexLoader';

// ── Constants ───────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

// ── Types ───────────────────────────────────────────────────────────

/** A searchable document chunk with metadata */
interface IndexedChunk {
  readonly content: string;
  readonly source: string;
  readonly keywords: readonly string[];
  readonly estimatedTokens: number;
  readonly section?: string;
  readonly level: string;
}

// ── Provider ────────────────────────────────────────────────────────

export class LocalMainContextProvider implements IMainContextProvider {
  private readonly chunks: readonly IndexedChunk[];

  constructor(
    mdcChunks: readonly MdcChunk[],
    contextIndex: ContextIndex,
    cheatsheetContent?: string,
  ) {
    this.chunks = this.buildIndex(mdcChunks, contextIndex, cheatsheetContent);
  }

  /**
   * Search local documentation by keyword relevance scoring.
   *
   * Scoring algorithm:
   * 1. Exact substring match in content → 0.9
   * 2. Keyword overlap (query tokens ∩ chunk keywords) → 0.3–0.8
   * 3. Section title match → +0.1 bonus
   * 4. alwaysApply/parent chunks → +0.05 bonus
   */
  async search(
    query: string,
    maxResults: number,
  ): Promise<ReadonlyArray<{ content: string; source: string; score: number; tokens: number }>> {
    const queryTokens = this.tokenize(query);

    if (queryTokens.length === 0) return [];

    const scored = this.chunks.map((chunk) => ({
      chunk,
      score: this.scoreChunk(chunk, query, queryTokens),
    }));

    // Filter out zero-score matches, sort descending, take top N
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => ({
        content: s.chunk.content,
        source: s.chunk.source,
        score: s.score,
        tokens: s.chunk.estimatedTokens,
      }));
  }

  async getItemCount(): Promise<number> {
    return this.chunks.length;
  }

  // ── Index Building ────────────────────────────────────────────────

  private buildIndex(
    mdcChunks: readonly MdcChunk[],
    contextIndex: ContextIndex,
    cheatsheetContent?: string,
  ): IndexedChunk[] {
    const indexed: IndexedChunk[] = [];

    // 1. Index MDC chunks (hierarchical rule files)
    for (const chunk of mdcChunks) {
      indexed.push({
        content: chunk.content,
        source: chunk.source,
        keywords: this.tokenize(chunk.content + ' ' + (chunk.section ?? '')),
        estimatedTokens: chunk.estimatedTokens,
        section: chunk.section,
        level: chunk.level,
      });
    }

    // 2. Index CONTEXT_INDEX sections
    const ciSections: Array<{ key: string; data: unknown }> = [
      { key: 'invariants', data: contextIndex.invariants },
      { key: 'layers', data: contextIndex.layers },
      { key: 'entrypoint', data: contextIndex.entrypoint },
      { key: 'error_recovery', data: contextIndex.error_recovery },
      { key: 'file_placement', data: contextIndex.file_placement },
      { key: 'di_tokens_key', data: contextIndex.di_tokens_key },
      { key: 'metrics', data: contextIndex.metrics },
    ];

    for (const { key, data } of ciSections) {
      if (data == null) continue;
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      indexed.push({
        content: text,
        source: `CONTEXT_INDEX.json#${key}`,
        keywords: this.tokenize(`${key} ${text}`),
        estimatedTokens: this.estimateTokens(text),
        section: key,
        level: 'document',
      });
    }

    // 3. Index AI_CHEATSHEET sections (if provided)
    if (cheatsheetContent) {
      const sections = this.splitMarkdownSections(cheatsheetContent);
      for (const section of sections) {
        indexed.push({
          content: section.content,
          source: `AI_CHEATSHEET.md#${section.title}`,
          keywords: this.tokenize(section.title + ' ' + section.content),
          estimatedTokens: this.estimateTokens(section.content),
          section: section.title,
          level: 'document',
        });
      }
    }

    return indexed;
  }

  // ── Scoring ───────────────────────────────────────────────────────

  private scoreChunk(
    chunk: IndexedChunk,
    rawQuery: string,
    queryTokens: readonly string[],
  ): number {
    let score = 0;
    const contentLower = chunk.content.toLowerCase();
    const queryLower = rawQuery.toLowerCase();

    // Exact substring match in content → high score
    if (contentLower.includes(queryLower)) {
      score = 0.9;
    } else {
      // Keyword overlap scoring
      const overlap = queryTokens.filter((qt) => chunk.keywords.includes(qt));
      if (overlap.length > 0) {
        score = 0.3 + 0.5 * (overlap.length / queryTokens.length);
      }
    }

    if (score === 0) return 0;

    // Section title bonus
    if (chunk.section) {
      const sectionLower = chunk.section.toLowerCase();
      if (queryTokens.some((qt) => sectionLower.includes(qt))) {
        score = Math.min(1.0, score + 0.1);
      }
    }

    // Parent/document level bonus (broader context)
    if (chunk.level === 'parent' || chunk.level === 'document') {
      score = Math.min(1.0, score + 0.05);
    }

    return Math.round(score * 1000) / 1000; // 3 decimal places
  }

  // ── Utilities ─────────────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .filter((w, i, arr) => arr.indexOf(w) === i); // deduplicate
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  private splitMarkdownSections(
    content: string,
  ): Array<{ title: string; content: string }> {
    const sections: Array<{ title: string; content: string }> = [];
    const lines = content.split('\n');
    let currentTitle = '_header';
    let currentLines: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^#{1,3}\s+(.+)$/);
      if (headerMatch) {
        if (currentLines.length > 0) {
          sections.push({ title: currentTitle, content: currentLines.join('\n') });
        }
        currentTitle = headerMatch[1].trim();
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0) {
      sections.push({ title: currentTitle, content: currentLines.join('\n') });
    }

    return sections;
  }
}
