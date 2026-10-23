/**
 * IDecisionAttributionAnalyzer — Domain port for causal chain attribution of agent decisions.
 *
 * CC-034 Decision Attribution Analyzer: builds structured causal chains from trajectory
 * intelligence (CC-033) to attribute decisions to root causes. Decomposes outcomes into
 * immediate → proximate → root cause chains, and classifies attribution types as
 * failure, recovery, inefficiency, or success attribution.
 *
 * Key Innovation: Multi-Level Causal Attribution
 *   - 3-level causal chain: immediate trigger → proximate cause → root cause
 *   - 4 attribution types: failure, recovery, inefficiency, success
 *   - Evidence-linked: each cause references specific reasoning steps
 *   - Impact quantification: numerical impact score per attribution
 *
 * Difference from CC-030 (ContrastiveLessonLearner):
 *   CC-030 does contrastive factor analysis (which factors differ between success/failure).
 *   CC-034 does structured causal chain decomposition (WHY did it succeed/fail).
 *   CC-030 → "factor X is present in 80% of successes" (statistical).
 *   CC-034 → "failure caused by A, which was caused by B, rooted in C" (causal).
 *
 * Integration Points:
 *   - ITrajectoryIntelligenceExtractor (CC-033) — upstream intelligence source
 *   - IContextualTipGenerator (CC-035) — downstream tip generation
 *   - IS2iLessonExtractor (CC-023) — raw lesson extraction
 *   - IContrastiveLessonLearner (CC-030) — complementary statistical analysis
 *
 * Academic Basis:
 *   - Trajectory-Informed Memory (arXiv:2603.10600, Mar 2026) — Decision Attribution Analyzer
 *   - SAMULE (arXiv:2509.20562, EMNLP 2025) — micro/meso/macro reflection levels
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M2 decomposed prompting
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-034 Decision Attribution Analyzer (TIM arXiv:2603.10600)
 * @see src/domain/memory/ITrajectoryIntelligenceExtractor.ts — CC-033 upstream
 * @see src/domain/memory/IContextualTipGenerator.ts — CC-035 downstream
 */

import type {
  TrajectoryIntelligenceResult,
  TrajectoryOutcomeClassification,
} from './ITrajectoryIntelligenceExtractor';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Attribution type — classifies the decision attribution category.
 * From arXiv:2603.10600 §3.2: failure/recovery/inefficiency/success attribution.
 */
export type AttributionType = 'failure' | 'recovery' | 'inefficiency' | 'success';

/**
 * Causal level — position in the causal chain.
 * 3-level decomposition from arXiv:2603.10600 §3.2.
 */
export type CausalLevel = 'immediate' | 'proximate' | 'root_cause';

/** A single cause in the causal chain. */
export interface CausalNode {
  /** Causal level in the chain hierarchy. */
  readonly level: CausalLevel;
  /** Description of the cause. */
  readonly description: string;
  /** Step indices from the trajectory that evidence this cause. */
  readonly evidenceSteps: readonly number[];
  /** Confidence in this causal link (0.0-1.0). */
  readonly confidence: number;
}

/**
 * A complete causal chain: immediate → proximate → root cause.
 * May have multiple nodes at the same level for complex scenarios.
 */
export interface CausalChain {
  /** The immediate trigger (what happened). */
  readonly immediate: CausalNode;
  /** The proximate cause (why it happened). */
  readonly proximate: CausalNode;
  /** The root cause (underlying reason). */
  readonly rootCause: CausalNode;
  /** Overall chain confidence (product of individual confidences). */
  readonly chainConfidence: number;
}

/** A single decision attribution result. */
export interface DecisionAttribution {
  /** Unique attribution ID. */
  readonly attributionId: string;
  /** Type of attribution. */
  readonly attributionType: AttributionType;
  /** The structured causal chain. */
  readonly causalChain: CausalChain;
  /** Impact score (0.0-1.0): how much this decision affected the outcome. */
  readonly impactScore: number;
  /** Step in the trajectory where this decision occurred. */
  readonly decisionStep: number;
  /** What alternative decision could have been better (if applicable). */
  readonly alternativeAction?: string;
}

/** Full attribution result for a trajectory. */
export interface DecisionAttributionResult {
  /** Source trajectory ID. */
  readonly trajectoryId: string;
  /** Outcome classification from upstream intelligence. */
  readonly outcomeClassification: TrajectoryOutcomeClassification;
  /** All attributions found for this trajectory. */
  readonly attributions: readonly DecisionAttribution[];
  /** Primary root cause (highest impact attribution). */
  readonly primaryRootCause?: string;
  /** Whether a recovery pattern was attributed. */
  readonly recoveryAttributed: boolean;
  /** Analysis timestamp. */
  readonly analyzedAt: string;
}

/** Configuration for decision attribution analysis. */
export interface AttributionConfig {
  /** Minimum confidence for including an attribution. Default: 0.4. */
  readonly minAttributionConfidence: number;
  /** Whether to suggest alternative actions. Default: true. */
  readonly suggestAlternatives: boolean;
  /** Maximum attributions per trajectory. Default: 10. */
  readonly maxAttributions: number;
}

/** Default attribution configuration. */
export const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  minAttributionConfidence: 0.4,
  suggestAlternatives: true,
  maxAttributions: 10,
};

/** Attribution statistics. */
export interface AttributionStats {
  /** Total trajectories analyzed. */
  readonly trajectoriesAnalyzed: number;
  /** Attribution type distribution. */
  readonly typeDistribution: Record<AttributionType, number>;
  /** Average attribution count per trajectory. */
  readonly avgAttributionsPerTrajectory: number;
  /** Most common root causes (descriptions). */
  readonly topRootCauses: readonly string[];
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Decision Attribution Analyzer — builds causal chains from trajectory intelligence
 * to explain WHY agent decisions led to specific outcomes.
 */
export interface IDecisionAttributionAnalyzer {
  /**
   * Analyze decisions from trajectory intelligence and produce causal attributions.
   *
   * @param intelligence - Structured trajectory intelligence (from CC-033)
   * @param config - Attribution configuration
   * @returns Attribution result with causal chains
   */
  analyzeDecisions(
    intelligence: TrajectoryIntelligenceResult,
    config?: AttributionConfig,
  ): DecisionAttributionResult;

  /**
   * Analyze decisions from multiple trajectories (batch).
   *
   * @param intelligences - Array of trajectory intelligences
   * @param config - Attribution configuration
   * @returns Array of attribution results
   */
  analyzeBatch(
    intelligences: readonly TrajectoryIntelligenceResult[],
    config?: AttributionConfig,
  ): readonly DecisionAttributionResult[];

  /**
   * Get attribution statistics across all analyzed trajectories.
   *
   * @returns Aggregate attribution stats
   */
  getStats(): AttributionStats;

  /** Reset all state. */
  reset(): void;
}
