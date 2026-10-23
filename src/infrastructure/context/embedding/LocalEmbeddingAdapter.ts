/**
 * LocalEmbeddingAdapter — Fallback embedding via BM25-style hashing.
 *
 * When no OpenAI API key is available, provides a local deterministic
 * embedding using term-frequency hashing. Not as accurate as dense
 * embeddings, but works without any external API.
 *
 * Approach: hash-based feature extraction with 256 dimensions.
 * Produces sparse-like vectors from token trigrams.
 *
 * @layer Infrastructure (Context / Embedding)
 * @since v2.9.0 — Phase 2 (V3 Context Engineering)
 */

import type { IEmbeddingAdapter } from './IEmbeddingAdapter';

/** Number of hash buckets (dimensions) */
const DIMENSIONS = 256;

/**
 * Simple deterministic string hash (DJB2).
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Extract n-gram tokens from text for hashing.
 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ').filter(w => w.length > 1);
  const tokens: string[] = [...words];
  // Add bigrams for better semantic signal
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`);
  }
  return tokens;
}

export class LocalEmbeddingAdapter implements IEmbeddingAdapter {
  readonly dimensions = DIMENSIONS;
  readonly model = 'local-bm25-hash-256d';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.embedSingle(text));
  }

  private embedSingle(text: string): number[] {
    const vector = new Float64Array(DIMENSIONS);
    const tokens = tokenize(text);

    if (tokens.length === 0) return Array.from(vector);

    // Hash each token into a bucket
    for (const token of tokens) {
      const bucket = hashString(token) % DIMENSIONS;
      vector[bucket] += 1;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < DIMENSIONS; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < DIMENSIONS; i++) {
        vector[i] = vector[i] / norm;
      }
    }

    return Array.from(vector);
  }
}
