/**
 * IS2iLessonExtractor — Domain port for Self-Synthesizing Instruction extraction.
 *
 * CC-023 S2I Lesson Extractor: automated extraction of lessons from PUA SUCCESS
 * outcomes. Classifies lessons at three SAMULE levels (Micro/Meso/Macro) and
 * proposes instruction amendments when trigger conditions are met.
 *
 * Pipeline:
 *   PUA Success Ledger entry → IS2iLessonExtractor.extractLesson()
 *     → SAMULE classification (Micro/Meso/Macro)
 *     → Lesson stored with evidence citations
 *     → If ≥3 MACRO-INSIGHTs share root cause → proposeAmendment()
 *
 * S2I Maturity Model:
 *   S2I-1 (Manual): Human reviews Success Ledger → writes PUA rules [ACTIVE]
 *   S2I-2 (Semi-Automated): Agent proposes amendments from accumulated patterns [THIS PORT]
 *   S2I-3 (Auto-Synthesized): System auto-drafts rules from ≥5 sessions [ROADMAP]
 *
 * Academic Basis:
 *   - SAMULE (arXiv:2509.20562, EMNLP 2025) — multi-level reflection (Micro/Meso/Macro)
 *   - Trajectory-Informed Memory (arXiv:2603.10600) — learnings from execution trajectories
 *   - TDAD (arXiv:2603.08806) — agent prompts as compiled artifacts
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-023 S2I Lesson Extractor (PUA Phase 12 → codified)
 * @see .github/instructions/pua-exhaustive-debugging.instructions.md — S2I section
 */

// ── Types ──────────────────────────────────────────────────────────

/** SAMULE reflection level for lesson classification. */
export type SamuleLevel = 'micro' | 'meso' | 'macro';

/** Root cause category from the PUA Success Ledger. */
export type RootCauseCategory =
  | 'config'
  | 'logic'
  | 'assumption'
  | 'environment'
  | 'integration'
  | 'missing_test'
  | 'architecture'
  | 'dependency';

/** Optional extraction overrides for non-PUA lesson sources using the S2I pipeline. */
export interface SuccessLedgerLessonContext {
  /** Source marker for downstream consumers such as review queues. */
  readonly origin?: string;
  /** Explicit lesson identifier to preserve cross-tool references. */
  readonly lessonId?: string;
  /** Explicit SAMULE level when source evidence already classified the lesson. */
  readonly levelHint?: SamuleLevel;
  /** Prefix override for the emitted lesson statement. */
  readonly statementPrefix?: string;
  /** Prevention override when upstream source already synthesized guidance. */
  readonly prevention?: string;
  /** Extraction timestamp override when upstream source wants stable ordering. */
  readonly extractedAt?: string;
  /** Additional retrieval tags required by downstream tooling. */
  readonly tags?: readonly string[];
  /** Skip S2I trigger-stat tracking for non-PUA review artifacts. */
  readonly skipTracking?: boolean;
}

/** A PUA Success Ledger entry used as input for lesson extraction. */
export interface SuccessLedgerEntry {
  /** Unique identifier for this entry. */
  readonly entryId: string;
  /** The PUA rhetoric flavor that triggered the breakthrough. */
  readonly winningFlavor: string;
  /** Which of the 5 PUA methodology steps produced the decisive insight. */
  readonly winningStep: number;
  /** Root cause classification. */
  readonly rootCauseCategory: RootCauseCategory;
  /** Free-text lessons learned. */
  readonly lessonsLearned: string;
  /** Trajectory quality score (0-10). */
  readonly trajectoryScore: number;
  /** Reliability level (0.0-1.0). */
  readonly reliabilityLevel: number;
  /** Files affected by the fix. */
  readonly affectedFiles: readonly string[];
  /** Timestamp of the success. */
  readonly timestamp: string;
  /** Optional session identifier. */
  readonly sessionId?: string;
  /** Optional lesson extraction overrides for review-queue and other derived sources. */
  readonly lessonContext?: SuccessLedgerLessonContext;
}

/** An extracted lesson with SAMULE classification. */
export interface ExtractedLesson {
  /** Unique lesson identifier. */
  readonly lessonId: string;
  /** SAMULE level classification. */
  readonly level: SamuleLevel;
  /** Concise lesson statement. */
  readonly statement: string;
  /** Root cause category from the source entry. */
  readonly rootCauseCategory: RootCauseCategory;
  /** Evidence: source Success Ledger entry ID. */
  readonly sourceEntryId: string;
  /** Prevention recommendation. */
  readonly prevention: string;
  /** Tags for cross-task retrieval. */
  readonly tags: readonly string[];
  /** Timestamp of extraction. */
  readonly extractedAt: string;
}

/** Review gate derived from observable evidence behind an S2I proposal. */
export type S2iProposalGateStatus = 'needs_more_evidence' | 'ready_for_review' | 'promotion_ready';

/** Evidence-weighted summary attached to each S2I amendment proposal. */
export interface S2iProposalEvidenceSummary {
  /** Number of extracted lessons explicitly supporting the proposal. */
  readonly evidenceLessonCount: number;
  /** Number of unique Success Ledger entries backing those lessons. */
  readonly uniqueSourceEntryCount: number;
  /** Count of micro-level lessons in the evidence set. */
  readonly microLessonCount: number;
  /** Count of meso-level lessons in the evidence set. */
  readonly mesoLessonCount: number;
  /** Count of macro-level lessons in the evidence set. */
  readonly macroLessonCount: number;
  /** Average source-entry reliability across linked evidence. */
  readonly averageSourceReliability: number;
  /** Average source-entry trajectory score across linked evidence. */
  readonly averageTrajectoryScore: number;
  /** Evidence-weighted gate score in [0, 1] for operator triage. */
  readonly gateScore: number;
  /** Review state derived from observable evidence instead of prose-only confidence. */
  readonly gateStatus: S2iProposalGateStatus;
  /** Durable promotion still requires an explicit contradiction review. */
  readonly contradictionCheckRequired: boolean;
}

/** An S2I-2 amendment proposal generated when trigger conditions are met. */
export interface S2iAmendmentProposal {
  /** Unique proposal identifier. */
  readonly proposalId: string;
  /** Proposed rule text. */
  readonly proposedRule: string;
  /** Evidence citations (lesson IDs). */
  readonly evidenceLessonIds: readonly string[];
  /** Suggested placement in PUA hierarchy. */
  readonly suggestedPlacement: string;
  /** Confidence band retained for backward-compatible consumers. */
  readonly confidence: 'low' | 'medium' | 'high';
  /** Structured evidence summary for review and promotion gating. */
  readonly evidenceSummary: S2iProposalEvidenceSummary;
  /** Trigger condition that generated this proposal. */
  readonly triggerCondition: string;
  /** Timestamp of generation. */
  readonly generatedAt: string;
  /** Whether this has been reviewed by a human. */
  readonly humanReviewed: boolean;
}

/** Trigger condition statistics for amendment proposal generation. */
export interface S2iTriggerStats {
  /** Number of MACRO-INSIGHT entries sharing same root cause category. */
  readonly macroInsightsByCategory: Record<string, number>;
  /** Number of times each Anti-Rationalization entry was triggered. */
  readonly antiRationalizationTriggers: Record<string, number>;
  /** Winning methodology step frequency per task class. */
  readonly winningStepFrequency: Record<number, number>;
  /** Median TrajectoryScore per failure mode. */
  readonly trajectoryScoreMedian: Record<string, number>;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * S2I Lesson Extractor — automated lesson extraction from PUA SUCCESS outcomes.
 *
 * Implements the S2I-2 Semi-Automated stage of the Self-Synthesizing Instructions
 * maturity model. Extracts, classifies, and stores lessons; proposes amendments
 * when trigger conditions are met.
 */
export interface IS2iLessonExtractor {
  /**
   * Extract a lesson from a PUA Success Ledger entry.
   * Classifies at the appropriate SAMULE level (Micro/Meso/Macro).
   *
   * @param entry - The Success Ledger entry to analyze
  * @returns The extracted and classified lesson once persisted state is ready
   */
  extractLesson(entry: SuccessLedgerEntry): Promise<ExtractedLesson>;

  /**
   * Retrieve all stored lessons, optionally filtered by SAMULE level.
   *
   * @param level - Optional SAMULE level filter
   * @returns Array of extracted lessons
   */
  getLessons(level?: SamuleLevel): readonly ExtractedLesson[];

  /**
   * Check trigger conditions and generate amendment proposals if thresholds are met.
   * Implements S2I-2 trigger conditions:
   *   1. ≥3 MACRO-INSIGHTs share same root cause category
   *   2. Same Anti-Rationalization entry triggered ≥5 times
   *   3. Winning step in ≥70% of Success Ledger entries for a task class
   *   4. TrajectoryScore median < 5.0 for a failure mode
   *
   * @returns Array of amendment proposals (empty if no triggers met)
   */
  checkTriggers(): readonly S2iAmendmentProposal[];

  /**
   * Get current trigger statistics for diagnostics.
   *
   * @returns Aggregated trigger condition statistics
   */
  getTriggerStats(): S2iTriggerStats;

  /**
   * Register an anti-rationalization trigger from a runtime detection.
   * Called when IIntentMisalignmentDetector detects a rationalization bypass
   * so that S2I-2 trigger counting accumulates from real runtime evidence.
   *
   * Optional — implementations without anti-rationalization tracking can omit.
   *
   * @param excuse - The matched excuse string from the Anti-Rationalization Table
  * @param sourceEntryId - Optional Success Ledger entry linked to the trigger
   */
  registerAntiRationalizationTrigger?(excuse: string, sourceEntryId?: string): void;

  /**
   * Optional readiness barrier for adapters that hydrate persisted state.
   * Consumers that require durable recurrence statistics can await it.
   */
  whenReady?(): Promise<void>;
}
