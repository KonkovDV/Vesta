/**
 * Text Chunker — splits large text into overlapping chunks.
 * 
 * Used for processing long documents before LLM extraction.
 * 
 * Layer: Memory/Ingestion
 */

import { ChunkingConfig, DEFAULT_CHUNKING_CONFIG } from './types';

/**
 * Result of chunking operation.
 */
export interface ChunkResult {
  /** Chunk text content */
  text: string;
  /** Start character index in original text */
  startIndex: number;
  /** End character index in original text */
  endIndex: number;
  /** Chunk sequence number */
  chunkIndex: number;
}

/**
 * Approximate token count using character-based heuristic.
 * ~4 characters per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into overlapping chunks.
 */
export function chunkText(
  text: string,
  config: Partial<ChunkingConfig> = {}
): ChunkResult[] {
  const { maxTokensPerChunk, overlapTokens, preserveSentences } = {
    ...DEFAULT_CHUNKING_CONFIG,
    ...config,
  };

  const maxChars = maxTokensPerChunk * 4;
  const overlapChars = overlapTokens * 4;

  if (text.length <= maxChars) {
    return [{
      text,
      startIndex: 0,
      endIndex: text.length,
      chunkIndex: 0,
    }];
  }

  const chunks: ChunkResult[] = [];
  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < text.length) {
    let endIndex = Math.min(startIndex + maxChars, text.length);

    // Adjust to sentence boundary if configured
    if (preserveSentences && endIndex < text.length) {
      const sentenceEnd = findSentenceEnd(text, startIndex + maxChars - 200, endIndex);
      if (sentenceEnd > startIndex + maxChars / 2) {
        endIndex = sentenceEnd;
      }
    }

    chunks.push({
      text: text.slice(startIndex, endIndex),
      startIndex,
      endIndex,
      chunkIndex,
    });

    chunkIndex++;
    startIndex = endIndex - overlapChars;

    // Prevent infinite loop
    if (startIndex >= text.length - 50) break;
  }

  return chunks;
}

/**
 * Find the end of a sentence within a range.
 */
function findSentenceEnd(text: string, start: number, end: number): number {
  const slice = text.slice(start, end);
  
  // Look for sentence-ending punctuation followed by space or end
  const patterns = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
  
  let lastEnd = -1;
  for (const pattern of patterns) {
    const idx = slice.lastIndexOf(pattern);
    if (idx > lastEnd) {
      lastEnd = idx + pattern.length - 1;
    }
  }

  if (lastEnd > 0) {
    return start + lastEnd + 1;
  }

  // Fallback: look for any whitespace
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > slice.length / 2) {
    return start + lastSpace + 1;
  }

  return end;
}

/**
 * Merge overlapping facts from chunked processing.
 */
export function mergeChunkFacts<T extends { fact: string }>(
  factsByChunk: T[][],
  similarityThreshold = 0.85
): T[] {
  const allFacts = factsByChunk.flat();
  const uniqueFacts: T[] = [];

  for (const fact of allFacts) {
    const isDuplicate = uniqueFacts.some(existing => 
      calculateSimilarity(existing.fact, fact.fact) >= similarityThreshold
    );
    
    if (!isDuplicate) {
      uniqueFacts.push(fact);
    }
  }

  return uniqueFacts;
}

/**
 * Simple string similarity using Jaccard index on words.
 */
function calculateSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));

  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}
