/**
 * IIntentMisalignmentDetector — Domain port for IBAC 2.0 adversarial intent analysis.
 *
 * CC-026 Intent Misalignment Detector: implements the "worst possible interpretation"
 * second-order check recommended in the PUA v5.1 roadmap. Extends the existing
 * IToolExecutionPolicy (CC-012) with adversarial intent analysis — before a tool
 * call is executed, this detector evaluates what the *worst possible interpretation*
 * of the call would be and whether it could constitute rationalization bypass.
 *
 * The key insight from Taming OpenClaw (arXiv:2603.11619, Mar 2026) is that
 * point-based defense mechanisms fail against cross-temporal and multi-stage
 * systemic risks. IBAC 2.0 addresses this by maintaining a sliding window of
 * recent tool calls and evaluating their *cumulative* intent trajectory.
 *
 * Pipeline:
 *   Tool call request → IIntentMisalignmentDetector.analyze()
 *     → Worst-case interpretation generation
 *     → Cumulative trajectory analysis (sliding window)
 *     → Intent drift detection (semantic distance > 0.15)
 *     → MisalignmentVerdict: aligned / drifting / misaligned
 *
 * Academic Basis:
 *   - Taming OpenClaw (arXiv:2603.11619, Mar 2026) — lifecycle-oriented agent security
 *   - Park et al. (arXiv:2511.12001, Nov 2025) — confidence tone suppresses error detection
 *   - CBV Protocol (PUA Phase 12) — adversarial self-audit extension
 *   - Mouzouni (arXiv:2602.21368, Feb 2026) — conformal calibration for gating
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-026 Intent Misalignment Detector (PUA v5.1 → IBAC 2.0)
 * @see src/domain/security/tool-execution-policy.interface.ts — IToolExecutionPolicy
 */

// ── Types ──────────────────────────────────────────────────────────

/** The assessed intent alignment level. */
export type IntentAlignment = 'aligned' | 'drifting' | 'misaligned';

/** A tool call entry in the intent trajectory window. */
export interface IntentTrajectoryEntry {
  /** Tool name. */
  readonly toolName: string;
  /** Tool arguments summary (sanitized — no secrets). */
  readonly argumentsSummary: string;
  /** Stated task intent at the time of the call. */
  readonly taskIntent: string;
  /** Semantic distance from task intent (0.0-1.0). */
  readonly semanticDistance: number;
  /** Timestamp of the call. */
  readonly timestamp: string;
}

/** Worst-case interpretation of a tool call. */
export interface WorstCaseInterpretation {
  /** Description of the worst possible outcome. */
  readonly description: string;
  /** Severity if this interpretation were to be realized. */
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  /** Whether this interpretation constitutes rationalization bypass. */
  readonly isRationalizationBypass: boolean;
  /** Specific PUA Anti-Rationalization entry matched (if any). */
  readonly matchedExcuse?: string;
}

/** Full misalignment analysis result. */
export interface MisalignmentVerdict {
  /** Overall alignment assessment. */
  readonly alignment: IntentAlignment;
  /** Worst-case interpretation generated. */
  readonly worstCase: WorstCaseInterpretation;
  /** Current semantic drift from original task intent (0.0-1.0). */
  readonly currentDrift: number;
  /** Number of tool calls in the trajectory window. */
  readonly trajectoryLength: number;
  /** Cumulative drift trend: increasing, stable, decreasing. */
  readonly driftTrend: 'increasing' | 'stable' | 'decreasing';
  /** Whether Context Locking should activate (drift > 0.15). */
  readonly contextLockingRequired: boolean;
  /** Human-readable analysis summary. */
  readonly summary: string;
  /** Analysis timestamp. */
  readonly analyzedAt: string;
}

/** Configuration for the trajectory window and thresholds. */
export interface MisalignmentConfig {
  /** Sliding window size for trajectory analysis (default: 10). */
  readonly windowSize: number;
  /** Semantic distance threshold for "drifting" (default: 0.10). */
  readonly driftingThreshold: number;
  /** Semantic distance threshold for "misaligned" (default: 0.25). */
  readonly misalignedThreshold: number;
  /** Context Locking activation threshold (default: 0.15). */
  readonly contextLockThreshold: number;
}

/** Default configuration aligned with PUA Phase 11 Context Locking. */
export const DEFAULT_MISALIGNMENT_CONFIG: MisalignmentConfig = {
  windowSize: 10,
  driftingThreshold: 0.10,
  misalignedThreshold: 0.25,
  contextLockThreshold: 0.15,
};

// ── Main Interface ────────────────────────────────────────────────

/**
 * Intent Misalignment Detector — IBAC 2.0 adversarial intent analysis.
 *
 * Performs second-order "worst possible interpretation" analysis on tool calls
 * and maintains a sliding window for cumulative intent trajectory tracking.
 * Designed to be called before IToolExecutionPolicy.evaluate() to provide
 * an additional layer of intent verification.
 */
export interface IIntentMisalignmentDetector {
  /**
   * Analyze a tool call for potential intent misalignment.
   *
   * Generates a worst-case interpretation and checks cumulative trajectory.
   *
   * @param toolName - Name of the tool being called
   * @param argumentsSummary - Sanitized summary of tool arguments
   * @param taskIntent - The user's stated task intent
   * @param config - Analysis configuration
   * @returns Misalignment verdict
   */
  analyze(
    toolName: string,
    argumentsSummary: string,
    taskIntent: string,
    config?: MisalignmentConfig,
  ): MisalignmentVerdict;

  /**
   * Get the current intent trajectory window.
   *
   * @returns Recent tool call entries in chronological order
   */
  getTrajectory(): readonly IntentTrajectoryEntry[];

  /**
   * Set or update the current task intent anchor.
   * Resets drift calculations relative to the new intent.
   *
   * @param taskIntent - The new task intent statement
   */
  setTaskIntent(taskIntent: string): void;

  /**
   * Reset the trajectory window. Called at task boundaries.
   */
  reset(): void;
}
