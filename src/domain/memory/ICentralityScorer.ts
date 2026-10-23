/**
 * ICentralityScorer — Domain Port for Graph Centrality Analysis.
 *
 * Computes centrality metrics (PageRank, Betweenness, Degree) for
 * nodes in the code knowledge graph. Used to identify critical-path
 * components, architectural hotspots, and audit prioritization targets.
 *
 * Academic foundation:
 * - PageRank: Brin & Page, 1998 (Stanford, "The Anatomy of Search Engine")
 * - Betweenness Centrality: Freeman, 1977 (Sociometry)
 * - Code Centrality for Defect Prediction: Zimmermann & Nagappan, 2008 (ICSE)
 * - Structural Hotspot Detection: Tornhill, 2015 ("Your Code as a Crime Scene")
 *
 * Layer: Domain
 * SOTA 2026: Centrality-Based Risk Scoring for AI Code Intelligence
 */

import type { TenantId, CorrelationId } from './session-types';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Centrality algorithm to use. */
export type CentralityAlgorithm = 'pagerank' | 'betweenness' | 'degree';

/** Centrality score for a single node. */
export interface CentralityScore {
  /** Node identifier. */
  readonly nodeId: string;
  /** Node name (human-readable). */
  readonly name: string;
  /** File path of the node. */
  readonly filePath: string;
  /** Centrality score (normalized to [0, 1]). */
  readonly score: number;
  /** Rank position (1 = highest centrality). */
  readonly rank: number;
}

/** Full centrality analysis result. */
export interface CentralityResult {
  /** Algorithm used. */
  readonly algorithm: CentralityAlgorithm;
  /** Ranked list of nodes by centrality (descending). */
  readonly scores: readonly CentralityScore[];
  /** Number of nodes analyzed. */
  readonly nodeCount: number;
  /** Number of edges analyzed. */
  readonly edgeCount: number;
  /** Computation time in milliseconds. */
  readonly durationMs: number;
}

// ──────────────────────────────────────────────
// Domain Port
// ──────────────────────────────────────────────

/**
 * Centrality Scorer — Domain Port (L3).
 *
 * Computes graph centrality metrics for code knowledge graph nodes.
 * Used by AI agents for audit prioritization and risk assessment.
 *
 * Implementations: CentralityScorerAdapter (infrastructure).
 */
export interface ICentralityScorer {
  /** Compute centrality scores for all nodes in the graph. */
  computeCentrality(input: {
    tenantId: TenantId;
    algorithm: CentralityAlgorithm;
    /** Maximum number of top results to return. */
    topK?: number;
    /** Edge types to consider (default: all). */
    edgeTypes?: readonly string[];
    correlationId: CorrelationId;
  }): Promise<CentralityResult>;
}
