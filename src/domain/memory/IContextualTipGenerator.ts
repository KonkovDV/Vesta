/**
 * IContextualTipGenerator — Domain port for generating structured actionable tips from
 * decision attributions.
 *
 * CC-035 Contextual Tip Generator: the final stage of the Trajectory-Informed Memory
 * pipeline. Converts causal attributions (CC-034) into 3 types of actionable tips:
 * strategy, recovery, and optimization. Tips include structured steps, trigger conditions,
 * negative examples, and dual-level generalization (domain-specific + generic).
 *
 * Key Innovation: 3-Type Structured Tip Generation
 *   - Strategy tips: what approach to use for a task type
 *   - Recovery tips: how to recover from a specific failure mode
 *   - Optimization tips: how to improve efficiency of suboptimal but working approaches
 *   - Dual generalization: domain-specific version + generic transferable version
 *   - Negative examples: what NOT to do, derived from failure attributions
 *
 * Consolidation Pipeline:
 *   1. Description generalization (abstract away task-specific details)
 *   2. Semantic clustering (threshold ~0.85 similarity)
 *   3. LLM-based merging (deduplicate, resolve conflicts, synthesize)
 *
 * Integration Points:
 *   - IDecisionAttributionAnalyzer (CC-034) — upstream attribution source
 *   - IWisdomConsolidator (CC-027) — tips feed into macro-level consolidation
 *   - IContrastiveLessonLearner (CC-030) — anti-patterns provide negative examples
 *   - IMemoryRetrievalService — tips stored for context-aware retrieval
 *
 * Academic Basis:
 *   - Trajectory-Informed Memory (arXiv:2603.10600, Mar 2026) — Contextual Learning Generator
 *   - SAMULE (arXiv:2509.20562, EMNLP 2025) — macro-level lesson consolidation
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M4 Enhanced Data Registry
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-035 Contextual Tip Generator (TIM arXiv:2603.10600)
 * @see src/domain/memory/IDecisionAttributionAnalyzer.ts — CC-034 upstream
 * @see src/domain/memory/IWisdomConsolidator.ts — CC-027 downstream consolidation
 */

import type { DecisionAttributionResult } from './IDecisionAttributionAnalyzer';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Tip category — classifies the type of actionable guidance.
 * 3-type taxonomy from arXiv:2603.10600 §3.3.
 */
export type TipCategory = 'strategy' | 'recovery' | 'optimization';

/**
 * Generalization level — scope of the tip's applicability.
 * Dual-level from arXiv:2603.10600 §3.3.
 */
export type GeneralizationLevel = 'domain_specific' | 'generic';

/** A structured actionable tip. */
export interface StructuredTip {
  /** Unique tip ID. */
  readonly tipId: string;
  /** Tip category. */
  readonly category: TipCategory;
  /** Concise tip content/title. */
  readonly content: string;
  /** Detailed step-by-step guidance. */
  readonly steps: readonly string[];
  /** Trigger condition — when this tip is relevant. */
  readonly triggerCondition: string;
  /** Negative example — what NOT to do. */
  readonly negativeExample?: string;
  /** Priority score (0.0-1.0): how important/impactful this tip is. */
  readonly priority: number;
  /** Which trajectory(ies) this tip was derived from. */
  readonly provenance: readonly string[];
  /** Generalization level. */
  readonly generalizationLevel: GeneralizationLevel;
  /** Task domain this tip applies to (null for generic tips). */
  readonly taskDomain?: string;
  /** When this tip was generated. */
  readonly generatedAt: string;
}

/** A cluster of semantically similar tips. */
export interface TipCluster {
  /** Cluster ID. */
  readonly clusterId: string;
  /** Merged tip (representative of the cluster). */
  readonly mergedTip: StructuredTip;
  /** Original tip IDs that were merged into this cluster. */
  readonly memberTipIds: readonly string[];
  /** Average semantic similarity within the cluster. */
  readonly avgSimilarity: number;
}

/** Configuration for tip generation. */
export interface TipGenerationConfig {
  /** Enable dual-level generalization. Default: true. */
  readonly enableDualGeneralization: boolean;
  /** Minimum priority for tip inclusion. Default: 0.3. */
  readonly minPriority: number;
  /** Maximum tips per trajectory. Default: 5. */
  readonly maxTipsPerTrajectory: number;
  /** Similarity threshold for clustering. Default: 0.85. */
  readonly clusteringThreshold: number;
  /** Enable tip consolidation (clustering + merging). Default: true. */
  readonly enableConsolidation: boolean;
}

/** Default tip generation configuration. */
export const DEFAULT_TIP_CONFIG: TipGenerationConfig = {
  enableDualGeneralization: true,
  minPriority: 0.3,
  maxTipsPerTrajectory: 5,
  clusteringThreshold: 0.85,
  enableConsolidation: true,
};

/** Tip generation statistics. */
export interface TipStats {
  /** Total tips generated (before consolidation). */
  readonly totalTipsGenerated: number;
  /** Tips after consolidation (after clustering/merging). */
  readonly tipsAfterConsolidation: number;
  /** Category distribution. */
  readonly categoryDistribution: Record<TipCategory, number>;
  /** Clusters formed during consolidation. */
  readonly clustersFormed: number;
  /** Average priority score. */
  readonly avgPriority: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Contextual Tip Generator — produces structured actionable tips from decision
 * attributions, with optional consolidation (clustering + merging).
 */
export interface IContextualTipGenerator {
  /**
   * Optional readiness barrier for adapters that hydrate persisted state asynchronously.
   * Callers that depend on durable startup state should await this hook when available.
   */
  whenReady?(): Promise<void>;

  /**
   * Generate tips from a single attribution result.
   *
   * @param attribution - Decision attribution result (from CC-034)
   * @param config - Tip generation configuration
   * @returns Generated structured tips
   */
  generateTips(
    attribution: DecisionAttributionResult,
    config?: TipGenerationConfig,
  ): readonly StructuredTip[];

  /**
   * Generate tips from multiple attribution results (batch).
   *
   * @param attributions - Array of attribution results
   * @param config - Tip generation configuration
   * @returns All generated tips
   */
  generateBatch(
    attributions: readonly DecisionAttributionResult[],
    config?: TipGenerationConfig,
  ): readonly StructuredTip[];

  /**
   * Consolidate existing tips via semantic clustering and merging.
   *
   * @param tips - Tips to consolidate
   * @param config - Configuration (uses clusteringThreshold)
   * @returns Consolidated tip clusters
   */
  consolidate(
    tips: readonly StructuredTip[],
    config?: TipGenerationConfig,
  ): readonly TipCluster[];

  /**
   * Get all generated tips (accumulated across calls).
   *
   * @returns All tips generated so far
   */
  getAllTips(): readonly StructuredTip[];

  /**
   * Get tip generation statistics.
   *
   * @returns Aggregate stats
   */
  getStats(): TipStats;

  /** Feed live helpfulness audit back into generator calibration when available. */
  setHelpfulnessCalibration?(rate: number): void;

  /** Reset all state. */
  reset(): void;
}
