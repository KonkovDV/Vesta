/**
 * BM25 Text Ranker
 *
 * Pure-function BM25 (Best Matching 25) implementation for re-ranking
 * graph memory search results. Operates on tokenized documents.
 *
 * Ported from: external/mem0/mem0-ts/src/oss/src/utils/bm25.ts
 *
 * Used by GraphMemoryEngine to re-rank graph triples after cosine
 * similarity search, combining vector semantics with keyword relevance.
 *
 * Layer: Infrastructure/Memory/Graph
 * @module BM25Ranker
 */

/**
 * BM25 text ranking algorithm.
 *
 * Ranks a corpus of tokenized documents against a query.
 * Standard BM25 with configurable k1 (term saturation) and b (length normalization).
 *
 * @example
 * ```ts
 * const docs = [
 *   ['alice', 'loves', 'pizza'],
 *   ['bob', 'hates', 'pizza'],
 * ];
 * const bm25 = new BM25Ranker(docs);
 * const ranked = bm25.search(['alice', 'pizza']);
 * // ranked[0] = ['alice', 'loves', 'pizza'] (higher score)
 * ```
 */
export class BM25Ranker {
  private readonly documents: string[][];
  private readonly k1: number;
  private readonly b: number;
  private readonly avgDocLength: number;
  private readonly docFreq: Map<string, number>;
  private readonly docLengths: number[];
  private readonly idf: Map<string, number>;

  /**
   * @param documents - Corpus of tokenized documents (each doc is an array of tokens)
   * @param k1 - Term frequency saturation parameter (default: 1.5)
   * @param b - Document length normalization parameter (default: 0.75)
   */
  constructor(documents: string[][], k1 = 1.5, b = 0.75) {
    this.documents = documents;
    this.k1 = k1;
    this.b = b;
    this.docLengths = documents.map((doc) => doc.length);
    this.avgDocLength =
      documents.length > 0
        ? this.docLengths.reduce((a, c) => a + c, 0) / documents.length
        : 1;
    this.docFreq = new Map();
    this.idf = new Map();
    this.computeIdf();
  }

  /**
   * Compute IDF (Inverse Document Frequency) for all terms in the corpus.
   */
  private computeIdf(): void {
    const N = this.documents.length;

    for (const doc of this.documents) {
      const terms = new Set(doc);
      for (const term of terms) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    for (const [term, freq] of this.docFreq) {
      this.idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
    }
  }

  /**
   * Score a single document against a query.
   * Uses pre-computed term frequency map for O(1) TF lookups.
   */
  private score(query: string[], doc: string[], index: number): number {
    let totalScore = 0;
    const docLength = this.docLengths[index];

    // Pre-compute term frequency map: O(n) once instead of O(n) per term
    const tfMap = new Map<string, number>();
    for (const token of doc) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }

    for (const term of query) {
      const tf = tfMap.get(term) ?? 0;
      const idfVal = this.idf.get(term) ?? 0;

      totalScore +=
        (idfVal * tf * (this.k1 + 1)) /
        (tf +
          this.k1 * (1 - this.b + (this.b * docLength) / this.avgDocLength));
    }

    return totalScore;
  }

  /**
   * Rank all documents by relevance to the query.
   *
   * @param query - Tokenized query
   * @returns Documents sorted by descending BM25 score
   */
  search(query: string[]): string[][] {
    const scores = this.documents.map((doc, idx) => ({
      doc,
      score: this.score(query, doc, idx),
    }));

    return scores.sort((a, b) => b.score - a.score).map((item) => item.doc);
  }

  /**
   * Rank documents and return with scores for transparency.
   *
   * @param query - Tokenized query
   * @returns Array of {doc, score} sorted by descending score
   */
  searchWithScores(query: string[]): Array<{ doc: string[]; score: number }> {
    const scores = this.documents.map((doc, idx) => ({
      doc,
      score: this.score(query, doc, idx),
    }));

    return scores.sort((a, b) => b.score - a.score);
  }
}

/**
 * Tokenize a string for BM25 input.
 * Lowercases, splits on non-word characters, filters empty tokens.
 *
 * Supports Unicode letters (Cyrillic, CJK, etc.) via \p{L} regex.
 * The donor (Mem0) uses simple `query.split(' ')` — we improve on that
 * by also handling punctuation and normalizing case.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
}
