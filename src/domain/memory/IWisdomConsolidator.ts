/**
 * IWisdomConsolidator — Domain port for SAGE memory consolidation (Ebbinghaus 2.1).
 *
 * CC-027 Wisdom Consolidator: addresses the "Fragmented Wisdom" problem where
 * multiple micro-level SAMULE lessons that share the same root cause pattern
 * fail to be synthesized into macro-level principles before they individually
 * decay below the retention threshold. This creates knowledge loss when
 * individually-weak signals collectively represent a strong pattern.
 *
 * The Wisdom Consolidator implements R-03 from the PUA v5.1 roadmap:
 *   1. Scans accumulated micro/meso lessons for consolidation candidates
 *   2. Applies conformal gating (Mouzouni arXiv:2602.21368) — only lessons with
 *      ReliabilityLevel ≥ 0.98 are eligible for auto-promotion to macro
 *   3. Generates consolidated macro-principles from related micro-lessons
 *   4. Manages the lifecycle: consolidated micro-lessons can be archived
 *
 * Integration Points:
 *   - IS2iLessonExtractor (CC-023) — source of lessons to consolidate
 *   - ITemporalDecayStrategy (Ebbinghaus 2.0) — decay calculations
 *   - EbbinghausDecayCalculator — shouldConsolidate() logic
 *   - IContinuousSymbiosisWatcher — detects wisdom fragmentation patterns
 *
 * Academic Basis:
 *   - SAMULE (arXiv:2509.20562, EMNLP 2025) — micro→meso→macro reflection levels
 *   - Mouzouni (arXiv:2602.21368, Feb 2026) — conformal calibration for reliability gating
 *   - Ebbinghaus (1885) — forgetting curve, spaced repetition
 *   - Trajectory-Informed Memory (arXiv:2603.10600) — trajectory extraction
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-027 Wisdom Consolidator (PUA v5.1 → Ebbinghaus 2.1)
 * @see src/domain/memory/ITemporalDecayStrategy.ts — Ebbinghaus 2.0 decay port
 * @see src/domain/agents/IS2iLessonExtractor.ts — S2I lesson source
 */

// ── Types ──────────────────────────────────────────────────────────

/** A group of related micro/meso lessons that can be consolidated. */
export interface ConsolidationCandidate {
  /** Unique identifier for this candidate group. */
  readonly candidateId: string;
  /** Lesson IDs that form this consolidation group. */
  readonly lessonIds: readonly string[];
  /** Shared root cause category across all lessons. */
  readonly sharedCategory: string;
  /** Shared pattern description detected across lessons. */
  readonly sharedPattern: string;
  /** Average reliability level across lessons. */
  readonly avgReliabilityLevel: number;
  /** Whether this candidate passes conformal gating (avgRL ≥ 0.98). */
  readonly passesConformalGate: boolean;
  /** Number of micro-lessons in this group. */
  readonly microCount: number;
  /** Number of meso-lessons in this group. */
  readonly mesoCount: number;
  /** Estimated time until first lesson decays below threshold (days). */
  readonly urgencyDays: number;
}

/** A consolidated macro-principle synthesized from related lessons. */
export interface ConsolidatedPrinciple {
  /** Unique identifier. */
  readonly principleId: string;
  /** SAMULE level — always 'macro' for consolidated principles. */
  readonly level: 'macro';
  /** The synthesized macro-principle statement. */
  readonly statement: string;
  /** Source lesson IDs that were consolidated. */
  readonly sourceLessonIds: readonly string[];
  /** Root cause category. */
  readonly rootCauseCategory: string;
  /** Prevention recommendation derived from the pattern. */
  readonly prevention: string;
  /** Reliability level — conformal-calibrated from source lessons. */
  readonly reliabilityLevel: number;
  /** Consolidation timestamp. */
  readonly consolidatedAt: string;
  /** Tags derived from all source lessons (deduplicated). */
  readonly tags: readonly string[];
}

/** Configuration for the consolidation process. */
export interface ConsolidationConfig {
  /** Minimum number of related lessons to trigger consolidation (default: 3). */
  readonly minLessonsForConsolidation: number;
  /** Conformal reliability gate — minimum avgRL for auto-consolidation (default: 0.98). */
  readonly conformalGateThreshold: number;
  /** Maximum age in days for lessons to be eligible (default: 30). */
  readonly maxAgeDays: number;
  /** Whether to archive source micro-lessons after consolidation (default: true). */
  readonly archiveSourceLessons: boolean;
}

/** Default configuration aligned with R-02 CoV+ and R-03 SAGE. */
export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minLessonsForConsolidation: 3,
  conformalGateThreshold: 0.98,
  maxAgeDays: 30,
  archiveSourceLessons: true,
};

/** Statistics about the consolidation state. */
export interface ConsolidationStats {
  /** Total lessons scanned. */
  readonly totalLessonsScanned: number;
  /** Number of consolidation candidates found. */
  readonly candidatesFound: number;
  /** Number of candidates passing conformal gate. */
  readonly candidatesPassingGate: number;
  /** Number of principles already consolidated. */
  readonly principlesGenerated: number;
  /** Number of source lessons archived after consolidation. */
  readonly lessonsArchived: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Wisdom Consolidator — SAGE memory consolidation for fragmented micro-lessons.
 *
 * Detects "Fragmented Wisdom" patterns where individually-weak micro-lessons
 * collectively represent a macro-level insight, and consolidates them before
 * they individually decay below the retention threshold.
 */
export interface IWisdomConsolidator {
  /**
   * Scan lessons for consolidation candidates.
   *
   * Groups related micro/meso lessons by root cause category and pattern,
   * evaluates conformal gating, and returns candidate groups.
   *
   * @param lessons - Lessons to analyze (typically from IS2iLessonExtractor)
   * @param config - Consolidation configuration
   * @returns Array of consolidation candidates
   */
  findCandidates(
    lessons: ReadonlyArray<{
      readonly lessonId: string;
      readonly level: string;
      readonly rootCauseCategory: string;
      readonly statement: string;
      readonly tags: readonly string[];
      readonly extractedAt: string;
    }>,
    config?: ConsolidationConfig,
  ): readonly ConsolidationCandidate[];

  /**
   * Consolidate a candidate group into a macro-principle.
   *
   * Only candidates passing the conformal gate (avgRL ≥ threshold) are eligible.
   *
   * @param candidate - The candidate to consolidate
   * @param lessons - Original lessons for content synthesis
   * @returns The consolidated macro-principle, or null if candidate fails gating
   */
  consolidate(
    candidate: ConsolidationCandidate,
    lessons: ReadonlyArray<{
      readonly lessonId: string;
      readonly statement: string;
      readonly rootCauseCategory: string;
      readonly tags: readonly string[];
    }>,
  ): ConsolidatedPrinciple | null;

  /**
   * Get all consolidated principles.
   *
   * @returns Array of consolidated macro-principles
   */
  getPrinciples(): readonly ConsolidatedPrinciple[];

  /**
   * Get consolidation statistics.
   *
   * @returns Aggregated consolidation metrics
   */
  getStats(): ConsolidationStats;

  /**
   * Optional readiness barrier for adapters that hydrate persisted principles at startup.
   * Consumers requiring durable consolidated wisdom can await this hook deterministically.
   */
  whenReady?(): Promise<void>;
}
