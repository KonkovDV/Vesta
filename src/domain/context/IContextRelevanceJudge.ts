/**
 * IContextRelevanceJudge — Domain Port for Self-Reflective RAG Loop
 *
 * Evaluates retrieved S-MMU pages for relevance BEFORE injecting them into
 * the LLM prompt. Implements the "Verify → Rewrite → Retry" loop from
 * Google DeepMind's Self-RAG (2025) paper.
 *
 * Flow:
 *   1. S-MMU retrieves pages via ISemanticPagingService.getPage()
 *   2. IContextRelevanceJudge.judge() evaluates each page
 *   3. If insufficient → rewriteQuery() reformulates → retry getPage()
 *   4. After maxRetries or sufficient → return filtered pages
 *
 * Implementation strategies:
 *   - **Heuristic**: Keyword overlap + TF-IDF threshold (fast, <5ms)
 *   - **LLM-based**: Lightweight judge call (slower, higher quality)
 *   - **Hybrid**: Heuristic gate → LLM fallback for borderline cases
 *
 * Academic References:
 *   - Asai et al. (2024) "Self-RAG: Learning to Retrieve, Generate and Critique"
 *   - Google DeepMind (2025) "Verify → Rewrite → Retry" retrieval loops
 *   - Anthropic (2025) "Hybrid retrieval with cross-encoder re-ranking"
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @horizon Horizon 2 — Context Engineering: Self-Reflective RAG
 * @pattern REC-089-01 Self-Reflective RAG Loop
 */

import type { CorrelationId } from '@/ai-types';
import type { SemanticPage } from './ISemanticPagingService';

// ── Relevance Verdict ─────────────────────────────────────────────

/** Per-page relevance verdict. */
export type RelevanceVerdict = 'relevant' | 'partial' | 'irrelevant';

/** Evaluation result for a single S-MMU page. */
export interface PageRelevanceEvaluation {
  /** Page ID being evaluated. */
  readonly pageId: string;
  /** Relevance verdict. */
  readonly verdict: RelevanceVerdict;
  /** Confidence score (0.0–1.0). */
  readonly confidence: number;
  /** Brief reason for the verdict. */
  readonly reason: string;
}

// ── Batch Evaluation Result ───────────────────────────────────────

/** Result of evaluating a batch of pages against a query. */
export interface RelevanceJudgmentResult {
  /** Overall relevance of the retrieved set (0.0–1.0). */
  readonly overallRelevance: number;
  /** Whether the retrieval is considered sufficient for the query. */
  readonly isSufficient: boolean;
  /** Per-page evaluations. */
  readonly evaluations: readonly PageRelevanceEvaluation[];
  /** Pages filtered as relevant or partial. */
  readonly acceptedPages: readonly SemanticPage[];
  /** Pages filtered as irrelevant. */
  readonly rejectedPages: readonly SemanticPage[];
  /** If isSufficient===false, a reformulated query for retry. */
  readonly suggestedRewrite?: string;
  /** Strategy used for judgment (heuristic/llm/hybrid). */
  readonly strategyUsed: JudgmentStrategy;
}

/** Strategy for how relevance is judged. */
export type JudgmentStrategy = 'heuristic' | 'llm' | 'hybrid';

// ── Self-Reflective Loop Config ───────────────────────────────────

/** Configuration for the self-reflective RAG retry loop. */
export interface SelfReflectiveConfig {
  /** Maximum retry attempts before accepting whatever is available. */
  readonly maxRetries: number;
  /** Minimum overall relevance threshold to consider sufficient (0.0–1.0). */
  readonly sufficiencyThreshold: number;
  /** Minimum per-page confidence to keep (0.0–1.0). */
  readonly minPageConfidence: number;
  /** Strategy for judgment. */
  readonly strategy: JudgmentStrategy;
}

// ── Port Interface ────────────────────────────────────────────────

/**
 * IContextRelevanceJudge — judges S-MMU pages for relevance
 * and supports query rewriting for retry loops.
 *
 * Injected via DI into SemanticPagingService or a wrapping orchestrator.
 * When absent, the system degrades gracefully (no filtering, no retry).
 */
export interface IContextRelevanceJudge {
  /**
   * Evaluate relevance of retrieved pages against the query.
   *
   * @param query — original search query
   * @param pages — pages retrieved by S-MMU
   * @param correlationId — for observability
   * @returns Judgment with accepted/rejected pages and optional rewrite
   */
  judge(
    query: string,
    pages: readonly SemanticPage[],
    correlationId?: CorrelationId,
  ): Promise<RelevanceJudgmentResult>;

  /**
   * Rewrite a query based on judgment feedback.
   * Used when judge() returns isSufficient===false and suggestedRewrite is not enough.
   *
   * @param originalQuery — the query that produced poor results
   * @param feedback — textual feedback about why results were poor
   * @returns A reformulated query for retry
   */
  rewriteQuery(
    originalQuery: string,
    feedback: string,
  ): Promise<string>;

  /**
   * Get the current configuration.
   */
  getConfig(): SelfReflectiveConfig;
}
