/**
 * RerankerAdapter — Infrastructure adapter for semantic reranking
 * Layer: Infrastructure
 *
 * @sota-stub — Uses TF-IDF / Jaccard similarity as stand-in for
 *   a real cross-encoder or ColBERTv2 model. Ready for replacement
 *   with actual model inference (ONNX, HuggingFace API, etc.).
 *
 * @see arXiv:2112.01488 — ColBERTv2
 * @see src/domain/context/reranker-service.port.ts — domain port
 */

import type {
  IRerankerService,
  RerankingConfig,
  RerankingResult,
  ScoredDocument,
} from '../../domain/context/reranker-service.port';
import { DEFAULT_RERANKING_CONFIG } from '../../domain/context/reranker-service.port';

interface ILogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export class RerankerAdapter implements IRerankerService {
  private readonly config: RerankingConfig;

  constructor(
    private readonly logger?: ILogger,
    config?: Partial<RerankingConfig>,
  ) {
    this.config = { ...DEFAULT_RERANKING_CONFIG, ...config };
  }

  async rerank(
    query: string,
    documents: readonly ScoredDocument[],
    config?: Partial<RerankingConfig>,
  ): Promise<RerankingResult> {
    const start = Date.now();
    const cfg = { ...this.config, ...config };

    const candidates = documents.slice(0, cfg.maxCandidates);
    if (candidates.length === 0) {
      return { documents: [], filteredCount: 0, strategyUsed: cfg.strategy, durationMs: 0 };
    }

    let scored: Array<{ doc: ScoredDocument; score: number }>;

    switch (cfg.strategy) {
      case 'late_interaction':
        scored = this.lateInteractionRerank(query, candidates);
        break;
      case 'score_fusion':
        scored = this.scoreFusionRerank(query, candidates);
        break;
      case 'cross_encoder':
      default:
        scored = this.crossEncoderRerank(query, candidates);
        break;
    }

    // Normalize
    if (cfg.normalizeScores && scored.length > 1) {
      const max = Math.max(...scored.map(s => s.score));
      const min = Math.min(...scored.map(s => s.score));
      const range = max - min || 1;
      scored = scored.map(s => ({ ...s, score: (s.score - min) / range }));
    }

    // Sort descending, filter by minScore
    scored.sort((a, b) => b.score - a.score);
    const passing = scored.filter(s => s.score >= cfg.minScore);

    const reranked: ScoredDocument[] = passing.map(({ doc, score }) => ({
      ...doc,
      rerankScore: score,
    }));

    const durationMs = Date.now() - start;
    this.logger?.info('reranker_completed', {
      strategy: cfg.strategy,
      input: documents.length,
      output: reranked.length,
      filtered: scored.length - passing.length,
      durationMs,
    });

    return {
      documents: reranked,
      filteredCount: scored.length - passing.length,
      strategyUsed: cfg.strategy,
      durationMs,
    };
  }

  getConfig(): RerankingConfig {
    return { ...this.config };
  }

  async isAvailable(): Promise<boolean> {
    return true; // TF-IDF stub is always available
  }

  // ─── Private Strategies ────────────────────────────────────────────

  /**
   * Cross-encoder: compute TF-IDF cosine similarity between query and each doc.
   */
  private crossEncoderRerank(
    query: string,
    docs: readonly ScoredDocument[],
  ): Array<{ doc: ScoredDocument; score: number }> {
    const queryTerms = this.tokenize(query);
    const querySet = new Set(queryTerms);
    const idf = this.computeIdf(queryTerms, docs.map(d => d.content));

    return docs.map(doc => {
      const docTf = this.computeTf(this.tokenize(doc.content));
      let dot = 0, qNorm = 0, dNorm = 0;

      for (const term of querySet) {
        const idfVal = idf.get(term) ?? 0;
        const qW = idfVal;              // binary TF for query
        const dW = (docTf.get(term) ?? 0) * idfVal;
        dot += qW * dW;
        qNorm += qW * qW;
        dNorm += dW * dW;
      }

      const cosine = qNorm > 0 && dNorm > 0
        ? dot / (Math.sqrt(qNorm) * Math.sqrt(dNorm))
        : 0;

      // Blend: 30% original + 70% cross-encoder
      const score = doc.originalScore * 0.3 + cosine * 0.7;
      return { doc, score };
    });
  }

  /**
   * Late interaction: ColBERTv2-style MaxSim.
   * For each query token, find max similarity to any doc token, then sum.
   */
  private lateInteractionRerank(
    query: string,
    docs: readonly ScoredDocument[],
  ): Array<{ doc: ScoredDocument; score: number }> {
    const queryTokens = this.tokenize(query);

    return docs.map(doc => {
      const docTokens = new Set(this.tokenize(doc.content));
      let maxSimSum = 0;

      for (const qt of queryTokens) {
        let best = 0;
        for (const dt of docTokens) {
          const sim = this.jaccardSim(qt, dt);
          if (sim > best) best = sim;
        }
        maxSimSum += best;
      }

      const normalized = queryTokens.length > 0 ? maxSimSum / queryTokens.length : 0;
      const score = doc.originalScore * 0.4 + normalized * 0.6;
      return { doc, score };
    });
  }

  /**
   * Reciprocal rank fusion: combine original score with term overlap score.
   */
  private scoreFusionRerank(
    query: string,
    docs: readonly ScoredDocument[],
  ): Array<{ doc: ScoredDocument; score: number }> {
    const queryTerms = new Set(this.tokenize(query));

    // Rank by original score
    const byOriginal = [...docs].sort((a, b) => b.originalScore - a.originalScore);
    const originalRank = new Map(byOriginal.map((d, i) => [d.documentId, i + 1]));

    // Rank by term overlap
    const overlapScored = docs.map(doc => {
      const docTerms = new Set(this.tokenize(doc.content));
      let overlap = 0;
      for (const t of queryTerms) if (docTerms.has(t)) overlap++;
      return { doc, overlap: queryTerms.size > 0 ? overlap / queryTerms.size : 0 };
    });
    const byOverlap = [...overlapScored].sort((a, b) => b.overlap - a.overlap);
    const overlapRank = new Map(byOverlap.map((d, i) => [d.doc.documentId, i + 1]));

    // RRF with k=60
    const k = 60;
    return docs.map(doc => {
      const r1 = originalRank.get(doc.documentId) ?? docs.length;
      const r2 = overlapRank.get(doc.documentId) ?? docs.length;
      const score = 1 / (k + r1) + 1 / (k + r2);
      return { doc, score };
    });
  }

  // ─── NLP Helpers ───────────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  }

  private computeTf(terms: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    // Normalize by doc length
    for (const [k, v] of tf) tf.set(k, v / terms.length);
    return tf;
  }

  private computeIdf(queryTerms: string[], docContents: string[]): Map<string, number> {
    const idf = new Map<string, number>();
    const n = docContents.length;
    for (const term of new Set(queryTerms)) {
      const df = docContents.filter(c => c.toLowerCase().includes(term)).length;
      idf.set(term, Math.log((n + 1) / (df + 1)) + 1);
    }
    return idf;
  }

  private jaccardSim(a: string, b: string): number {
    if (a === b) return 1;
    const setA = new Set(a.split(''));
    const setB = new Set(b.split(''));
    let inter = 0;
    for (const c of setA) if (setB.has(c)) inter++;
    const union = setA.size + setB.size - inter;
    return union > 0 ? inter / union : 0;
  }
}
