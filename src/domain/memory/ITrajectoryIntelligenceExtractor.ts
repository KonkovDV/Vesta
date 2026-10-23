/**
 * ITrajectoryIntelligenceExtractor — Domain port for semantic analysis of agent reasoning trajectories.
 *
 * CC-033 Trajectory Intelligence Extractor: analyzes agent execution trajectories to
 * extract structured intelligence about reasoning patterns, cognitive strategies, and
 * outcome classifications. This is the first stage of the Trajectory-Informed Memory
 * pipeline: raw trajectory → structured intelligence → attribution → tips.
 *
 * Key Innovation: Semantic Reasoning Pattern Extraction
 *   - Classifies reasoning steps into 4 types (analytical/planning/validation/reflection)
 *   - Detects 6 cognitive patterns (systematic elimination, divide-and-conquer, etc.)
 *   - Classifies outcomes into 4 categories (clean success, inefficient success, recovery, failure)
 *   - Supports subtask-level segmentation for fine-grained analysis
 *
 * Output Hierarchy:
 *   Raw Trajectory → Intelligence (CC-033) → Attribution (CC-034) → Tips (CC-035)
 *   Each stage produces progressively more actionable knowledge.
 *
 * Integration Points:
 *   - IContrastiveLessonLearner (CC-030) — intelligence feeds contrastive analysis
 *   - IDecisionAttributionAnalyzer (CC-034) — consumes intelligence for causal attribution
 *   - IExecutionProvenanceTracer (CC-019) — raw trajectory data source
 *   - IAgentEventStream (CC-017) — chronological action log
 *
 * Academic Basis:
 *   - Trajectory-Informed Memory (arXiv:2603.10600, Mar 2026) — primary source
 *   - SAMULE (arXiv:2509.20562, EMNLP 2025) — multi-level reflection framework
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M3 single-task specialization
 *   - PROBE (arXiv:2510.19771, Feb 2026) — Search→Identify→Resolve proactivity
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-033 Trajectory Intelligence Extractor (TIM arXiv:2603.10600)
 * @see src/domain/memory/IDecisionAttributionAnalyzer.ts — CC-034 downstream
 */

// ── Types ──────────────────────────────────────────────────────────

/**
 * Reasoning step type — classifies the cognitive nature of an agent's action.
 * Based on the 4-type taxonomy from arXiv:2603.10600 §3.1.
 */
export type ReasoningType = 'analytical' | 'planning' | 'validation' | 'reflection';

/**
 * Cognitive pattern — higher-order strategies detected in reasoning sequences.
 * Based on the 6-pattern taxonomy from arXiv:2603.10600 §3.1.
 */
export type CognitivePattern =
  | 'systematic_elimination'
  | 'divide_and_conquer'
  | 'hypothesis_testing'
  | 'pattern_recognition'
  | 'backtracking'
  | 'trial_and_error';

/**
 * Outcome classification — describes how the trajectory resolved.
 * 4-way classification from arXiv:2603.10600 §3.2.
 */
export type TrajectoryOutcomeClassification =
  | 'clean_success'
  | 'inefficient_success'
  | 'recovery'
  | 'failure';

/** A single reasoning step extracted from a trajectory. */
export interface ReasoningStep {
  /** Sequential index within the trajectory (0-based). */
  readonly stepIndex: number;
  /** The reasoning type classification. */
  readonly reasoningType: ReasoningType;
  /** Brief description of the action/observation. */
  readonly description: string;
  /** Tool invoked during this step (if any). */
  readonly toolUsed?: string;
  /** Whether this step produced new information vs. repeated prior knowledge. */
  readonly producedNewInfo: boolean;
}

/** A detected cognitive pattern with evidence. */
export interface DetectedPattern {
  /** The identified cognitive pattern. */
  readonly pattern: CognitivePattern;
  /** Step indices where this pattern was observed. */
  readonly evidenceSteps: readonly number[];
  /** Confidence score (0.0-1.0). */
  readonly confidence: number;
}

/** A segmented subtask within a larger trajectory. */
export interface TrajectorySubtask {
  /** Subtask identifier. */
  readonly subtaskId: string;
  /** Description of the subtask goal. */
  readonly goal: string;
  /** Step index range [start, end) inclusive. */
  readonly startStep: number;
  readonly endStep: number;
  /** Outcome of this specific subtask. */
  readonly outcome: TrajectoryOutcomeClassification;
}

/**
 * Raw trajectory input for intelligence extraction.
 * Represents a complete agent execution session.
 */
export interface AgentTrajectory {
  /** Unique trajectory identifier. */
  readonly trajectoryId: string;
  /** Task description that initiated the trajectory. */
  readonly taskDescription: string;
  /** Ordered sequence of action-observation pairs (text). */
  readonly steps: readonly string[];
  /** Whether the overall task was completed successfully. */
  readonly taskCompleted: boolean;
  /** Total steps taken. */
  readonly totalSteps: number;
  /** Optional: task domain/category for cross-domain analysis. */
  readonly taskDomain?: string;
  /** When the trajectory was recorded. */
  readonly recordedAt: string;
}

/** Full intelligence result from trajectory analysis. */
export interface TrajectoryIntelligenceResult {
  /** Source trajectory ID. */
  readonly trajectoryId: string;
  /** Overall outcome classification. */
  readonly outcomeClassification: TrajectoryOutcomeClassification;
  /** Extracted reasoning steps with type classification. */
  readonly reasoningSteps: readonly ReasoningStep[];
  /** Detected cognitive patterns across the trajectory. */
  readonly detectedPatterns: readonly DetectedPattern[];
  /** Subtask segmentation (empty if trajectory is simple). */
  readonly subtasks: readonly TrajectorySubtask[];
  /** Efficiency score (0.0-1.0): ratio of information-producing steps. */
  readonly efficiencyScore: number;
  /** Whether recovery from failure was observed. */
  readonly recoveryDetected: boolean;
  /**
   * Normalized step-length variance (0.0-1.0).
   * Proxy for reasoning quality consistency — high variance indicates
   * inconsistent step quality within the trajectory.
   * Computed as min(1.0, rawVariance / 10000).
   * @see arXiv:2601.15690 — Uncertainty as Metacognitive Control
   */
  readonly normalizedVariance?: number;
  /** Analysis timestamp. */
  readonly analyzedAt: string;
}

/** Configuration for trajectory intelligence extraction. */
export interface TrajectoryExtractionConfig {
  /** Enable subtask segmentation (slower but more granular). Default: true. */
  readonly enableSubtaskSegmentation: boolean;
  /** Minimum confidence for pattern detection (0.0-1.0). Default: 0.5. */
  readonly minPatternConfidence: number;
  /** Maximum steps to analyze (truncates long trajectories). Default: 200. */
  readonly maxSteps: number;
  /** Efficiency threshold below which "inefficient_success" is classified. Default: 0.6. */
  readonly efficiencyThreshold: number;
}

/** Default extraction configuration. */
export const DEFAULT_EXTRACTION_CONFIG: TrajectoryExtractionConfig = {
  enableSubtaskSegmentation: true,
  minPatternConfidence: 0.5,
  maxSteps: 200,
  efficiencyThreshold: 0.6,
};

/** Extraction statistics. */
export interface ExtractionStats {
  /** Total trajectories processed. */
  readonly trajectoriesProcessed: number;
  /** Outcome distribution. */
  readonly outcomeDistribution: Record<TrajectoryOutcomeClassification, number>;
  /** Most common cognitive patterns. */
  readonly topPatterns: readonly CognitivePattern[];
  /** Average efficiency score. */
  readonly avgEfficiency: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Trajectory Intelligence Extractor — analyses agent reasoning trajectories
 * to produce structured intelligence about cognitive strategies and outcomes.
 */
export interface ITrajectoryIntelligenceExtractor {
  /**
   * Extract intelligence from a single agent trajectory.
   *
   * @param trajectory - Raw agent trajectory
   * @param config - Extraction configuration
   * @returns Structured intelligence result
   */
  extractIntelligence(
    trajectory: AgentTrajectory,
    config?: TrajectoryExtractionConfig,
  ): TrajectoryIntelligenceResult;

  /**
   * Extract intelligence from multiple trajectories (batch).
   *
   * @param trajectories - Array of raw trajectories
   * @param config - Extraction configuration
   * @returns Array of intelligence results
   */
  extractBatch(
    trajectories: readonly AgentTrajectory[],
    config?: TrajectoryExtractionConfig,
  ): readonly TrajectoryIntelligenceResult[];

  /**
   * Get extraction statistics across all processed trajectories.
   *
   * @returns Aggregate extraction stats
   */
  getStats(): ExtractionStats;

  /** Reset all state. */
  reset(): void;

  /**
   * Optional readiness barrier for adapters that hydrate persisted state at startup.
   * Consumers that depend on durable history can await this hook for deterministic reads.
   */
  whenReady?(): Promise<void>;
}
