/**
 * IContrastiveLessonLearner — Domain port for contrastive success/failure trajectory analysis.
 *
 * CC-030 Contrastive Lesson Learner: extends CC-027 (WisdomConsolidator) with
 * active comparison of successful vs failed trajectories within the same root cause
 * category. While CC-027 passively consolidates similar lessons, CC-030 actively
 * contrasts them to extract discriminating factors — "what made 3 refactors succeed
 * but the 4th cause OOM?" — producing Anti-Patterns with causal attribution.
 *
 * Key Innovation: Contrastive Trajectory Analysis
 *   - Groups trajectories by category + operation type
 *   - Identifies factor sets: present in successes but absent in failures (and vice versa)
 *   - Generates Anti-Patterns with specific discriminating conditions
 *   - Converts passive experience into active recurrence prevention
 *
 * Output Hierarchy:
 *   Lessons (CC-023) → Consolidated Principles (CC-027) → Anti-Patterns (CC-030)
 *   Each level adds higher abstraction and actionability.
 *
 * Integration Points:
 *   - IWisdomConsolidator (CC-027) — supplies consolidated principles as input
 *   - IS2iLessonExtractor (CC-023) — supplies raw success/failure trajectories
 *   - ICbvShadowAuditor (CC-022) — anti-patterns feed red-team scenarios
 *
 * Academic Basis:
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M1 Iterative Similarity Convergence
 *   - Epistemic Context Learning (arXiv:2601.21742, Jan 2026) — calibrated trust → trajectory quality
 *   - SAMULE (arXiv:2509.20562, EMNLP 2025) — macro-reflection for cross-task patterns
 *   - Trajectory-Informed Memory (arXiv:2603.10600, Mar 2026) — learning from execution traces
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-030 Contrastive Lesson Learner (PUA v5.2 → Ebbinghaus 3.0)
 * @see src/domain/memory/IWisdomConsolidator.ts — CC-027 consolidation base
 */

// ── Types ──────────────────────────────────────────────────────────

/** Outcome classification for trajectory entries. */
export type TrajectoryOutcome = 'success' | 'failure';

/** Parent-selection strategy for archive-driven exploration. */
export type ParentSelectionStrategy = 'best' | 'score_prop' | 'score_child_prop';

/** A trajectory entry for contrastive analysis. */
export interface ContrastiveTrajectoryEntry {
  /** Unique trajectory ID. */
  readonly trajectoryId: string;
  /** Root cause category (shared grouping key). */
  readonly rootCauseCategory: string;
  /** Specific operation type within the category. */
  readonly operationType: string;
  /** Outcome of this trajectory. */
  readonly outcome: TrajectoryOutcome;
  /** Factors present during this trajectory (key contextual conditions). */
  readonly factors: readonly string[];
  /** Trajectory score (0-10) from PUA Success Ledger. */
  readonly trajectoryScore: number;
  /** Reliability level (0.0-1.0). */
  readonly reliabilityLevel: number;
  /** Lesson statement from S2I extraction. */
  readonly lessonStatement: string;
  /** Optional lineage link to the trajectory from which this one branched. */
  readonly parentTrajectoryId?: string;
  /** Whether this trajectory remains eligible as a future parent. Default: true. */
  readonly canSelectParent?: boolean;
  /** When this trajectory occurred. */
  readonly recordedAt: string;
}

/** Parent candidate scored from historical archive state. */
export interface ParentSelectionCandidate {
  /** Candidate trajectory identifier. */
  readonly trajectoryId: string;
  /** Root cause category of the candidate. */
  readonly rootCauseCategory: string;
  /** Operation type of the candidate. */
  readonly operationType: string;
  /** Optional parent lineage of the candidate itself. */
  readonly parentTrajectoryId?: string;
  /** Number of children already branched from this candidate. */
  readonly childCount: number;
  /** Raw blended quality score before penalty shaping. */
  readonly baseScore: number;
  /** Final score after strategy shaping and any child penalty. */
  readonly finalScore: number;
  /** Selection weight actually used by weighted strategies. */
  readonly selectionWeight: number;
  /** Original trajectory score. */
  readonly trajectoryScore: number;
  /** Original reliability level. */
  readonly reliabilityLevel: number;
}

/** Configuration for archive-driven parent selection. */
export interface ParentSelectionConfig {
  /** Optional operation type filter. */
  readonly operationType?: string;
  /** Selection strategy. */
  readonly strategy: ParentSelectionStrategy;
  /** Minimum reliability required to stay eligible. Default: 0.4. */
  readonly minReliabilityLevel: number;
  /** Minimum trajectory score required to stay eligible. Default: 4.0. */
  readonly minTrajectoryScore: number;
  /** Child penalty scale for `score_child_prop`. Default: 3. */
  readonly childPenaltyScale: number;
}

/** Default archive-driven parent-selection configuration. */
export const DEFAULT_PARENT_SELECTION_CONFIG: ParentSelectionConfig = {
  strategy: 'score_child_prop',
  minReliabilityLevel: 0.4,
  minTrajectoryScore: 4.0,
  childPenaltyScale: 3,
};

/** Result of selecting a parent trajectory from history. */
export interface ParentSelectionResult {
  /** Root cause category searched. */
  readonly rootCauseCategory: string;
  /** Strategy used for ranking/selection. */
  readonly strategy: ParentSelectionStrategy;
  /** Candidate that was selected. */
  readonly selected: ParentSelectionCandidate;
  /** All scored candidates, highest score first. */
  readonly candidates: readonly ParentSelectionCandidate[];
  /** When selection occurred. */
  readonly selectedAt: string;
}

/** A discriminating factor found via contrastive analysis. */
export interface DiscriminatingFactor {
  /** The factor name/description. */
  readonly factor: string;
  /** Frequency in successful trajectories (0.0-1.0). */
  readonly successFrequency: number;
  /** Frequency in failed trajectories (0.0-1.0). */
  readonly failureFrequency: number;
  /** Discrimination strength: |successFreq - failureFreq|. */
  readonly discriminationStrength: number;
  /** Direction: factor present in successes but not failures, or vice versa. */
  readonly direction: 'success_marker' | 'failure_marker';
}

/** An anti-pattern generated from contrastive analysis. */
export interface AntiPattern {
  /** Unique anti-pattern ID. */
  readonly antiPatternId: string;
  /** Root cause category. */
  readonly rootCauseCategory: string;
  /** Operation type. */
  readonly operationType: string;
  /** The anti-pattern statement — what to avoid. */
  readonly statement: string;
  /** Discriminating factors that distinguish success from failure. */
  readonly discriminatingFactors: readonly DiscriminatingFactor[];
  /** Specific conditions under which the failure occurs. */
  readonly failureConditions: readonly string[];
  /** Recommended prevention measures. */
  readonly prevention: readonly string[];
  /** Number of success trajectories analyzed. */
  readonly successCount: number;
  /** Number of failure trajectories analyzed. */
  readonly failureCount: number;
  /** Confidence (0.0-1.0) based on sample size and discrimination strength. */
  readonly confidence: number;
  /** When this anti-pattern was generated. */
  readonly generatedAt: string;
}

/** Configuration for contrastive analysis. */
export interface ContrastiveConfig {
  /** Minimum trajectories (success+failure) to attempt analysis (default: 3). */
  readonly minTrajectories: number;
  /** Minimum failure count required (default: 1). */
  readonly minFailures: number;
  /** Discrimination strength threshold for factor inclusion (default: 0.3). */
  readonly discriminationThreshold: number;
  /** Confidence threshold for anti-pattern generation (default: 0.6). */
  readonly confidenceThreshold: number;
  /**
   * Enable adaptive threshold: automatically lowers minTrajectories when
   * categories have high discrimination strength (>0.7), allowing earlier
   * anti-pattern detection from fewer samples. Default: false.
   */
  readonly adaptiveThreshold: boolean;
}

/** Default configuration. */
export const DEFAULT_CONTRASTIVE_CONFIG: ContrastiveConfig = {
  minTrajectories: 3,
  minFailures: 1,
  discriminationThreshold: 0.3,
  confidenceThreshold: 0.6,
  adaptiveThreshold: false,
};

/** Statistics about contrastive learning. */
export interface ContrastiveStats {
  /** Total trajectories analyzed. */
  readonly totalTrajectories: number;
  /** Success trajectory count. */
  readonly successCount: number;
  /** Failure trajectory count. */
  readonly failureCount: number;
  /** Anti-patterns generated. */
  readonly antiPatternsGenerated: number;
  /** Unique categories analyzed. */
  readonly categoriesAnalyzed: number;
  /** Categories with zero new anti-patterns after analysis (stale/dead-end categories). */
  readonly deadTrajectoryCategories: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Contrastive Lesson Learner — extracts anti-patterns by comparing success/failure trajectories.
 *
 * Actively contrasts "what worked" with "what failed" within the same category
 * to identify discriminating factors and generate actionable anti-patterns.
 */
export interface IContrastiveLessonLearner {
  /**
   * Add a trajectory entry for contrastive analysis.
   *
   * @param entry - Trajectory entry with outcome classification
   */
  addTrajectory(entry: ContrastiveTrajectoryEntry): void;

  /**
   * Analyze trajectories for a specific category and generate anti-patterns.
   *
   * @param rootCauseCategory - Category to analyze
   * @param config - Analysis configuration
   * @returns Generated anti-patterns (may be empty if insufficient data)
   */
  analyzeCategory(
    rootCauseCategory: string,
    config?: ContrastiveConfig,
  ): readonly AntiPattern[];

  /**
   * Analyze all categories with sufficient trajectory data.
   *
   * @param config - Analysis configuration
   * @returns All generated anti-patterns across categories
   */
  analyzeAll(config?: ContrastiveConfig): readonly AntiPattern[];

  /**
   * Select a reusable parent trajectory from historical archive state.
   *
   * Uses past trajectory quality and archive branching pressure to keep
   * exploration non-greedy while avoiding over-expanding the same parent.
   *
   * @param rootCauseCategory - Category archive to search
   * @param config - Parent-selection configuration
   * @returns Selection result or undefined when no eligible parent exists
   */
  selectParentTrajectory(
    rootCauseCategory: string,
    config?: ParentSelectionConfig,
  ): Promise<ParentSelectionResult | undefined>;

  /**
   * Get all generated anti-patterns.
   *
   * @returns Previously generated anti-patterns
   */
  getAntiPatterns(): readonly AntiPattern[];

  /**
   * Get statistics.
   *
   * @returns Contrastive analysis statistics
   */
  getStats(): ContrastiveStats;

  /** Reset all state. */
  reset(): void;
}
