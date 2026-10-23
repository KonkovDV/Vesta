/**
 * RetrievalEvaluatorAdapter — CRAG-style retrieval quality evaluator
 * Layer: Infrastructure
 *
 * @sota-stub — Uses heuristic term-overlap scoring as stand-in for
 *   a trained retrieval evaluator. Ready for replacement with actual
 *   NLI model or fine-tuned classifier.
 *
 * @see arXiv:2401.15884 — Corrective Retrieval Augmented Generation
 * @see src/domain/context/retrieval-evaluator.port.ts — domain port
 */

import type {
  IRetrievalEvaluator,
  RetrievalEvaluatorConfig,
  RetrievalEvaluationResult,
  RetrievalConfidenceLevel,
  CorrectiveAction,
  DocumentEvaluation,
} from '../../domain/context/retrieval-evaluator.port';
import { DEFAULT_EVALUATOR_CONFIG } from '../../domain/context/retrieval-evaluator.port';
import type { ScoredDocument } from '../../domain/context/reranker-service.port';

interface ILogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export class RetrievalEvaluatorAdapter implements IRetrievalEvaluator {
  private readonly config: RetrievalEvaluatorConfig;

  constructor(
    private readonly logger?: ILogger,
    config?: Partial<RetrievalEvaluatorConfig>,
  ) {
    this.config = { ...DEFAULT_EVALUATOR_CONFIG, ...config };
  }

  async evaluate(
    query: string,
    documents: readonly ScoredDocument[],
    config?: Partial<RetrievalEvaluatorConfig>,
  ): Promise<RetrievalEvaluationResult> {
    const start = Date.now();
    const cfg = { ...this.config, ...config };

    if (documents.length === 0) {
      return {
        confidenceLevel: 'incorrect',
        confidenceScore: 0,
        recommendedAction: 'refuse',
        documentEvaluations: [],
        relevantDocuments: [],
        irrelevantDocuments: [],
        durationMs: Date.now() - start,
      };
    }

    const docsToEval = documents.slice(0, cfg.maxDocuments);

    // Evaluate each document
    const docEvals = docsToEval.map(doc => this.evaluateDocument(query, doc, cfg));

    const relevant = docEvals.filter(e => e.isRelevant).map(e => e.document);
    const irrelevant = docEvals.filter(e => !e.isRelevant).map(e => e.document);

    // Compute aggregate confidence
    const confidenceScore = this.computeConfidence(docEvals, cfg);

    let confidenceLevel: RetrievalConfidenceLevel;
    if (confidenceScore >= cfg.correctThreshold) {
      confidenceLevel = 'correct';
    } else if (confidenceScore >= cfg.ambiguousThreshold) {
      confidenceLevel = 'ambiguous';
    } else {
      confidenceLevel = 'incorrect';
    }

    const recommendedAction = this.selectAction(confidenceLevel, relevant.length, cfg);

    // Generate optional query rewrite
    let suggestedRewrite: string | undefined;
    if (recommendedAction === 'rewrite_query' && cfg.enableRewrite) {
      suggestedRewrite = this.suggestRewrite(query, docEvals);
    }

    let subQueries: readonly string[] | undefined;
    if (recommendedAction === 'decompose' && cfg.enableDecompose) {
      subQueries = this.decompose(query);
    }

    const durationMs = Date.now() - start;
    this.logger?.info('retrieval_evaluated', {
      confidenceLevel,
      confidenceScore: +confidenceScore.toFixed(3),
      action: recommendedAction,
      relevant: relevant.length,
      irrelevant: irrelevant.length,
      durationMs,
    });

    return {
      confidenceLevel,
      confidenceScore,
      recommendedAction,
      documentEvaluations: docEvals,
      relevantDocuments: relevant,
      irrelevantDocuments: irrelevant,
      durationMs,
      suggestedRewrite,
      subQueries,
    };
  }

  async decomposeRecompose(
    query: string,
    documents: readonly ScoredDocument[],
  ): Promise<readonly ScoredDocument[]> {
    const queryTerms = new Set(this.tokenize(query));

    return documents.map(doc => {
      const sentences = this.splitSentences(doc.content);
      const relevant = sentences.filter(s => {
        const terms = this.tokenize(s);
        return terms.some(t => queryTerms.has(t));
      });

      if (relevant.length === 0) {
        // Preserve structural elements (code blocks, headers)
        const structural = this.extractStructural(doc.content);
        return structural
          ? { ...doc, content: structural, estimatedTokens: Math.ceil(structural.length / 4) }
          : doc;
      }

      const recomposed = relevant.join(' ');
      return {
        ...doc,
        content: recomposed,
        estimatedTokens: Math.ceil(recomposed.length / 4),
      };
    });
  }

  getConfig(): RetrievalEvaluatorConfig {
    return { ...this.config };
  }

  // ─── Private ───────────────────────────────────────────────────────

  private evaluateDocument(
    query: string,
    doc: ScoredDocument,
    cfg: RetrievalEvaluatorConfig,
  ): DocumentEvaluation {
    const queryTerms = this.tokenize(query);
    const docTerms = this.tokenize(doc.content);

    // Term overlap
    const overlap = this.termOverlap(queryTerms, docTerms);

    // Content quality heuristic (code blocks, import statements → higher quality)
    const quality = this.contentQuality(doc.content);

    // Combined score
    const relevanceScore = doc.originalScore * 0.4 + overlap * 0.35 + quality * 0.25;
    const isRelevant = relevanceScore >= cfg.ambiguousThreshold;

    return {
      document: doc,
      relevanceScore,
      isRelevant,
      explanation: `overlap=${overlap.toFixed(2)}, quality=${quality.toFixed(2)}, combined=${relevanceScore.toFixed(2)}`,
    };
  }

  private computeConfidence(
    evals: DocumentEvaluation[],
    cfg: RetrievalEvaluatorConfig,
  ): number {
    if (evals.length === 0) return 0;
    const relevantCount = evals.filter(e => e.isRelevant).length;
    const ratio = relevantCount / evals.length;
    const avgScore = relevantCount > 0
      ? evals.filter(e => e.isRelevant).reduce((s, e) => s + e.relevanceScore, 0) / relevantCount
      : 0;
    const minPageBoost = relevantCount >= cfg.minRelevantDocs ? 0.1 : 0;
    return Math.min(1, ratio * 0.4 + avgScore * 0.5 + minPageBoost);
  }

  private selectAction(
    level: RetrievalConfidenceLevel,
    relevantCount: number,
    cfg: RetrievalEvaluatorConfig,
  ): CorrectiveAction {
    switch (level) {
      case 'correct':
        return 'proceed';
      case 'ambiguous':
        return relevantCount >= cfg.minRelevantDocs ? 'augment' : 'decompose';
      case 'incorrect':
        return cfg.enableRewrite ? 'rewrite_query' : 'refuse';
    }
  }

  private suggestRewrite(query: string, evals: DocumentEvaluation[]): string {
    // Extract top terms from relevant docs to augment query
    const relevant = evals.filter(e => e.isRelevant);
    if (relevant.length === 0) return query;

    const docTerms = relevant.flatMap(e => this.tokenize(e.document.content));
    const freq = new Map<string, number>();
    for (const t of docTerms) freq.set(t, (freq.get(t) ?? 0) + 1);

    const querySet = new Set(this.tokenize(query));
    const topNew = [...freq.entries()]
      .filter(([t]) => !querySet.has(t) && t.length > 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

    return topNew.length > 0 ? `${query} ${topNew.join(' ')}` : query;
  }

  private decompose(query: string): string[] {
    // Split compound query on conjunctions/commas
    return query
      .split(/\s+(?:and|or|,)\s+/i)
      .map(s => s.trim())
      .filter(s => s.length > 2);
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  }

  private termOverlap(queryTerms: string[], docTerms: string[]): number {
    if (queryTerms.length === 0) return 0;
    const docSet = new Set(docTerms);
    const hits = queryTerms.filter(t => docSet.has(t)).length;
    return hits / queryTerms.length;
  }

  private contentQuality(content: string): number {
    let score = 0.5;
    if (content.includes('```')) score += 0.2;      // Code blocks
    if (content.includes('import ')) score += 0.1;   // Import statements
    if (content.includes('interface ')) score += 0.1; // TypeScript interfaces
    if (content.includes('export ')) score += 0.05;
    return Math.min(1, score);
  }

  private splitSentences(text: string): string[] {
    return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  }

  private extractStructural(content: string): string | undefined {
    const codeBlocks = content.match(/```[\s\S]*?```/g);
    const headers = content.match(/^#{1,6}\s+.+$/gm);
    const parts = [...(codeBlocks ?? []), ...(headers ?? [])];
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
}
