/**
 * S2iLessonExtractorAdapter — In-memory S2I-2 lesson extraction and storage.
 *
 * In-memory implementation of IS2iLessonExtractor. Extracts lessons from PUA
 * Success Ledger entries, classifies them at SAMULE levels (Micro/Meso/Macro),
 * checks trigger conditions, and generates amendment proposals.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-023 S2I Lesson Extractor (PUA Phase 12 → codified)
 * @see src/domain/agents/IS2iLessonExtractor.ts — domain port
 * @see src/core/events/s2i-lesson-extractor.schemas.ts — Zod validation schemas
 */

import type {
  IS2iLessonExtractor,
  SamuleLevel,
  RootCauseCategory,
  SuccessLedgerEntry,
  ExtractedLesson,
  S2iAmendmentProposal,
  S2iProposalEvidenceSummary,
  S2iProposalGateStatus,
  S2iTriggerStats,
} from '../../domain/agents/IS2iLessonExtractor';
import type { ILessonStore } from '../../domain/memory/ILessonStore';
import type { ISuccessLedgerStore } from '../../domain/memory/ISuccessLedgerStore';
import type { IWisdomConsolidator } from '../../domain/memory/IWisdomConsolidator';
import { sha256HexPrefix } from '../logging/RedactIdentifier';

// ── Minimal Logger ────────────────────────────────────────────────

interface ExtractorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── SAMULE Classification Thresholds ──────────────────────────────

const MACRO_TRAJECTORY_THRESHOLD = 8;
const MESO_RECURRENCE_THRESHOLD = 2;
const MACRO_INSIGHT_TRIGGER = 3;
const ANTI_RATIONALIZATION_TRIGGER = 5;
const WINNING_STEP_FREQ_THRESHOLD = 0.7;
const TRAJECTORY_SCORE_MEDIAN_LOW = 5.0;
const REVIEW_READY_GATE_THRESHOLD = 0.55;
const PROMOTION_READY_GATE_THRESHOLD = 0.85;

// ── Adapter ───────────────────────────────────────────────────────

export class S2iLessonExtractorAdapter implements IS2iLessonExtractor {
  private readonly lessons: ExtractedLesson[] = [];
  private readonly proposals: S2iAmendmentProposal[] = [];
  private readonly proposalsByKey = new Map<string, S2iAmendmentProposal>();
  private readonly entriesByCategory = new Map<RootCauseCategory, SuccessLedgerEntry[]>();
  private readonly entriesById = new Map<string, SuccessLedgerEntry>();
  private readonly antiRatTriggerCounts = new Map<string, number>();
  private readonly antiRatTriggerSources = new Map<string, Set<string>>();
  private readonly stepCounts = new Map<number, number>();
  private readonly trajectoryScores: number[] = [];
  private readonly trackedEntryIds = new Set<string>();
  private idCounter = Date.now();
  private readonly lessonStore: ILessonStore | undefined;
  private readonly successLedgerStore: ISuccessLedgerStore | undefined;
  private readonly consolidator: IWisdomConsolidator | undefined;
  private readonly hydrationPromise: Promise<void>;

  constructor(
    private readonly logger?: ExtractorLogger,
    lessonStore?: ILessonStore,
    successLedgerStore?: ISuccessLedgerStore,
    consolidator?: IWisdomConsolidator,
  ) {
    this.lessonStore = lessonStore;
    this.successLedgerStore = successLedgerStore;
    this.consolidator = consolidator;
    const startupTasks: Array<Promise<void>> = [];

    if (lessonStore || successLedgerStore) {
      startupTasks.push(
        this.hydrateState().catch((error) => {
          this.logger?.warn('S2I hydration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    if (consolidator?.whenReady) {
      startupTasks.push(
        consolidator.whenReady().catch((error) => {
          this.logger?.warn('S2I consolidation warmup failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    this.hydrationPromise = startupTasks.length > 0
      ? Promise.allSettled(startupTasks).then(() => undefined)
      : Promise.resolve();
  }

  async extractLesson(entry: SuccessLedgerEntry): Promise<ExtractedLesson> {
    await this.hydrationPromise;

    // Track entry for trigger condition analysis
    this.trackEntry(entry);

    // Classify SAMULE level
    const level = this.classifyLevel(entry);
    const extractedAt = entry.lessonContext?.extractedAt ?? entry.timestamp ?? new Date().toISOString();

    const lesson: ExtractedLesson = {
      lessonId: entry.lessonContext?.lessonId ?? `lesson-${++this.idCounter}`,
      level,
      statement: this.generateStatement(entry, level),
      rootCauseCategory: entry.rootCauseCategory,
      sourceEntryId: entry.entryId,
      prevention: this.generatePrevention(entry),
      tags: this.generateTags(entry, level),
      extractedAt,
    };

    this.mergeLessons([lesson]);

    const persistenceTasks: Array<{
      kind: 'lesson' | 'ledger';
      entityId: string;
      promise: Promise<void>;
    }> = [];

    if (this.lessonStore) {
      persistenceTasks.push({
        kind: 'lesson',
        entityId: lesson.lessonId,
        promise: this.lessonStore.saveLesson(lesson),
      });
    }

    if (this.successLedgerStore) {
      persistenceTasks.push({
        kind: 'ledger',
        entityId: entry.entryId,
        promise: this.successLedgerStore.saveEntry(entry),
      });
    }

    const persistenceResults = await Promise.allSettled(
      persistenceTasks.map((task) => task.promise),
    );

    persistenceResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }

      const task = persistenceTasks[index];
      this.logger?.warn(
        task.kind === 'lesson' ? 'Lesson persistence failed' : 'Success Ledger persistence failed',
        {
          entityId: task.entityId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
      );
    });

    await this.runAutoPromotion();

    this.logger?.info('Lesson extracted', {
      lessonId: lesson.lessonId,
      level,
      rootCause: entry.rootCauseCategory,
      trajectoryScore: entry.trajectoryScore,
    });

    return lesson;
  }

  getLessons(level?: SamuleLevel): readonly ExtractedLesson[] {
    if (!level) {
      return [...this.lessons];
    }
    return this.lessons.filter(l => l.level === level);
  }

  checkTriggers(): readonly S2iAmendmentProposal[] {
    const proposals: S2iAmendmentProposal[] = [];

    // Trigger 1: ≥3 MACRO-INSIGHTs sharing same root cause category
    const macroLessons = this.lessons.filter(l => l.level === 'macro');
    const macroByCategory = new Map<string, ExtractedLesson[]>();
    for (const lesson of macroLessons) {
      const existing = macroByCategory.get(lesson.rootCauseCategory) ?? [];
      existing.push(lesson);
      macroByCategory.set(lesson.rootCauseCategory, existing);
    }

    for (const [category, lessons] of macroByCategory) {
      if (lessons.length >= MACRO_INSIGHT_TRIGGER) {
        const evidenceLessonIds = lessons.map((lesson) => lesson.lessonId);
        const proposal = this.registerProposal({
          proposedRule: `[MACRO-INSIGHT] ${category}: ${lessons.length} recurring patterns detected. ` +
            `Common lesson: ${lessons[0].statement}. Consider adding explicit prevention rule.`,
          evidenceLessonIds,
          suggestedPlacement: 'Anti-Rationalization Table',
          evidenceSummary: this.buildProposalEvidenceSummary(evidenceLessonIds),
          triggerCondition: `≥${MACRO_INSIGHT_TRIGGER} MACRO-INSIGHTs sharing root cause: ${category}`,
        });
        proposals.push(proposal);
      }
    }

    // Trigger 2: Same Anti-Rationalization triggered ≥5 times
    for (const [excuse, count] of this.antiRatTriggerCounts) {
      if (count >= ANTI_RATIONALIZATION_TRIGGER) {
        const evidenceLessonIds = this.resolveEvidenceLessonIdsForExcuse(excuse);
        const proposal = this.registerProposal({
          proposedRule: `Anti-Rationalization "${excuse}" triggered ${count} times. ` +
            'Strengthen counter-attack or add specific mitigation steps.',
          evidenceLessonIds,
          suggestedPlacement: 'Anti-Rationalization Table',
          evidenceSummary: this.buildProposalEvidenceSummary(evidenceLessonIds),
          triggerCondition: `Anti-Rationalization "${excuse}" triggered ≥${ANTI_RATIONALIZATION_TRIGGER} times`,
        });
        proposals.push(proposal);
      }
    }

    // Trigger 3: Winning step ≥70% frequency
    const totalSteps = Array.from(this.stepCounts.values()).reduce((a, b) => a + b, 0);
    if (totalSteps > 0) {
      for (const [step, count] of this.stepCounts) {
        const freq = count / totalSteps;
        if (freq >= WINNING_STEP_FREQ_THRESHOLD) {
          const evidenceLessonIds = this.lessons.slice(-5).map((lesson) => lesson.lessonId);
          const proposal = this.registerProposal({
            proposedRule: `Step ${step} is the winning step in ${Math.round(freq * 100)}% of Success Ledger entries. ` +
              'Consider promoting this step to a primary debugging heuristic.',
            evidenceLessonIds,
            suggestedPlacement: 'Systematic Debugging Methodology',
            evidenceSummary: this.buildProposalEvidenceSummary(evidenceLessonIds),
            triggerCondition: `Winning step ${step} in ≥${Math.round(WINNING_STEP_FREQ_THRESHOLD * 100)}% of entries`,
          });
          proposals.push(proposal);
        }
      }
    }

    // Trigger 4: TrajectoryScore median < 5.0
    if (this.trajectoryScores.length >= 3) {
      const sorted = [...this.trajectoryScores].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

      if (median < TRAJECTORY_SCORE_MEDIAN_LOW) {
        const evidenceLessonIds = this.lessons.slice(-3).map((lesson) => lesson.lessonId);
        const proposal = this.registerProposal({
          proposedRule: `TrajectoryScore median is ${median.toFixed(1)} (below ${TRAJECTORY_SCORE_MEDIAN_LOW}). ` +
            'Debugging trajectories are suboptimal — consider restructuring initial approach selection.',
          evidenceLessonIds,
          suggestedPlacement: 'Pressure Escalation table or Step 1 (Smell)',
          evidenceSummary: this.buildProposalEvidenceSummary(evidenceLessonIds),
          triggerCondition: `TrajectoryScore median (${median.toFixed(1)}) < ${TRAJECTORY_SCORE_MEDIAN_LOW}`,
        });
        proposals.push(proposal);
      }
    }

    return proposals;
  }

  getTriggerStats(): S2iTriggerStats {
    // Macro insights by category
    const macroLessons = this.lessons.filter(l => l.level === 'macro');
    const macroByCategory: Record<string, number> = {};
    for (const l of macroLessons) {
      macroByCategory[l.rootCauseCategory] = (macroByCategory[l.rootCauseCategory] ?? 0) + 1;
    }

    // Anti-rationalization triggers
    const antiRatTriggers: Record<string, number> = {};
    for (const [key, val] of this.antiRatTriggerCounts) {
      antiRatTriggers[key] = val;
    }

    // Step frequency
    const stepFreq: Record<number, number> = {};
    for (const [step, count] of this.stepCounts) {
      stepFreq[step] = count;
    }

    // Trajectory score medians (grouped by root cause for simplicity)
    const scoresByCategory = new Map<string, number[]>();
    for (const lesson of this.lessons) {
      // Find matching entry's trajectory score
      const entries = this.entriesByCategory.get(lesson.rootCauseCategory) ?? [];
      const matchingEntry = entries.find(e => e.entryId === lesson.sourceEntryId);
      if (matchingEntry) {
        const existing = scoresByCategory.get(lesson.rootCauseCategory) ?? [];
        existing.push(matchingEntry.trajectoryScore);
        scoresByCategory.set(lesson.rootCauseCategory, existing);
      }
    }

    const medians: Record<string, number> = {};
    for (const [cat, scores] of scoresByCategory) {
      const sorted = [...scores].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medians[cat] = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }

    return {
      macroInsightsByCategory: macroByCategory,
      antiRationalizationTriggers: antiRatTriggers,
      winningStepFrequency: stepFreq,
      trajectoryScoreMedian: medians,
    };
  }

  // Allow external registration of anti-rationalization triggers
  registerAntiRationalizationTrigger(excuse: string, sourceEntryId?: string): void {
    const current = this.antiRatTriggerCounts.get(excuse) ?? 0;
    this.antiRatTriggerCounts.set(excuse, current + 1);

    if (!sourceEntryId) {
      return;
    }

    const existing = this.antiRatTriggerSources.get(excuse) ?? new Set<string>();
    existing.add(sourceEntryId);
    this.antiRatTriggerSources.set(excuse, existing);
  }

  whenReady(): Promise<void> {
    return this.hydrationPromise;
  }

  private async hydrateState(): Promise<void> {
    const [persistedLessonsResult, persistedEntriesResult] = await Promise.allSettled([
      this.lessonStore?.listLessons(),
      this.successLedgerStore?.listEntries(),
    ]);

    if (persistedLessonsResult.status === 'fulfilled') {
      const persistedLessons = persistedLessonsResult.value;
      if (persistedLessons && persistedLessons.length > 0) {
        this.mergeLessons(persistedLessons);
      }
    } else {
      this.logger?.warn('S2I hydration failed', {
        error: persistedLessonsResult.reason instanceof Error
          ? persistedLessonsResult.reason.message
          : String(persistedLessonsResult.reason),
      });
    }

    if (persistedEntriesResult.status === 'fulfilled') {
      const persistedEntries = persistedEntriesResult.value;
      if (persistedEntries && persistedEntries.length > 0) {
        for (const entry of persistedEntries) {
          this.trackEntry(entry);
        }
      }
    } else {
      this.logger?.warn('S2I hydration failed', {
        error: persistedEntriesResult.reason instanceof Error
          ? persistedEntriesResult.reason.message
          : String(persistedEntriesResult.reason),
      });
    }
  }

  private mergeLessons(lessons: readonly ExtractedLesson[]): void {
    const existingIds = new Set(this.lessons.map((lesson) => lesson.lessonId));
    for (const lesson of lessons) {
      if (existingIds.has(lesson.lessonId)) {
        continue;
      }
      this.lessons.push(lesson);
      this.syncIdCounterFromEntityId(lesson.lessonId);
      existingIds.add(lesson.lessonId);
    }
  }

  private syncIdCounterFromEntityId(entityId: string): void {
    const match = /^(?:lesson|s2i-prop)-(\d+)$/.exec(entityId);
    if (!match) {
      return;
    }

    this.idCounter = Math.max(this.idCounter, Number(match[1]));
  }

  private registerProposal(
    draft: Omit<S2iAmendmentProposal, 'proposalId' | 'generatedAt' | 'humanReviewed' | 'confidence'>,
  ): S2iAmendmentProposal {
    const proposalKey = this.buildProposalKey(draft);
    const existing = this.proposalsByKey.get(proposalKey);
    if (existing) {
      return existing;
    }

    const confidence = this.toConfidenceBand(draft.evidenceSummary);

    const proposal: S2iAmendmentProposal = {
      proposalId: `s2i-prop-${sha256HexPrefix(proposalKey, 16)}`,
      generatedAt: new Date().toISOString(),
      humanReviewed: false,
      confidence,
      ...draft,
    };

    this.proposals.push(proposal);
    this.proposalsByKey.set(proposalKey, proposal);
    this.logger?.info('S2I amendment proposed', {
      proposalId: proposal.proposalId,
      triggerCondition: proposal.triggerCondition,
      evidenceCount: proposal.evidenceLessonIds.length,
    });

    return proposal;
  }

  private buildProposalKey(
    draft: Omit<S2iAmendmentProposal, 'proposalId' | 'generatedAt' | 'humanReviewed' | 'confidence'>,
  ): string {
    const evidenceKey = [...draft.evidenceLessonIds].sort().join('|');
    return [draft.triggerCondition, draft.suggestedPlacement, evidenceKey].join('::');
  }

  private toConfidenceBand(evidenceSummary: S2iProposalEvidenceSummary): 'low' | 'medium' | 'high' {
    switch (evidenceSummary.gateStatus) {
      case 'promotion_ready':
        return 'high';
      case 'ready_for_review':
        return 'medium';
      default:
        return 'low';
    }
  }

  private async runAutoPromotion(): Promise<void> {
    if (!this.consolidator) {
      return;
    }

    try {
      const candidateInput = this.lessons.map((lesson) => ({
        lessonId: lesson.lessonId,
        level: lesson.level,
        rootCauseCategory: lesson.rootCauseCategory,
        statement: lesson.statement,
        tags: lesson.tags,
        extractedAt: lesson.extractedAt,
      }));
      const sourceInput = this.lessons.map((lesson) => ({
        lessonId: lesson.lessonId,
        statement: lesson.statement,
        rootCauseCategory: lesson.rootCauseCategory,
        tags: lesson.tags,
      }));

      const candidates = this.consolidator.findCandidates(candidateInput);
      for (const candidate of candidates) {
        const principle = this.consolidator.consolidate(candidate, sourceInput);
        if (!principle) {
          continue;
        }

        this.logger?.info('S2I macro principle promoted', {
          principleId: principle.principleId,
          sourceLessonCount: principle.sourceLessonIds.length,
          rootCause: principle.rootCauseCategory,
          reliabilityLevel: principle.reliabilityLevel,
        });
      }
    } catch (error) {
      this.logger?.warn('S2I consolidation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Private Methods ───────────────────────────────────────────

  private trackEntry(entry: SuccessLedgerEntry): void {
    if (this.trackedEntryIds.has(entry.entryId)) {
      return;
    }

    if (entry.lessonContext?.skipTracking) {
      this.trackedEntryIds.add(entry.entryId);
      return;
    }

    const existing = this.entriesByCategory.get(entry.rootCauseCategory) ?? [];
    existing.push(entry);
    this.entriesByCategory.set(entry.rootCauseCategory, existing);
    this.entriesById.set(entry.entryId, entry);

    this.stepCounts.set(entry.winningStep, (this.stepCounts.get(entry.winningStep) ?? 0) + 1);
    this.trajectoryScores.push(entry.trajectoryScore);
    this.trackedEntryIds.add(entry.entryId);
  }

  private buildProposalEvidenceSummary(evidenceLessonIds: readonly string[]): S2iProposalEvidenceSummary {
    const evidenceSet = new Set(evidenceLessonIds);
    const evidenceLessons = this.lessons.filter((lesson) => evidenceSet.has(lesson.lessonId));
    const sourceEntries = Array.from(new Set(evidenceLessons.map((lesson) => lesson.sourceEntryId)))
      .map((entryId) => this.entriesById.get(entryId))
      .filter((entry): entry is SuccessLedgerEntry => Boolean(entry));

    const microLessonCount = evidenceLessons.filter((lesson) => lesson.level === 'micro').length;
    const mesoLessonCount = evidenceLessons.filter((lesson) => lesson.level === 'meso').length;
    const macroLessonCount = evidenceLessons.filter((lesson) => lesson.level === 'macro').length;
    const evidenceLessonCount = evidenceLessons.length;
    const uniqueSourceEntryCount = sourceEntries.length;
    const averageSourceReliability = sourceEntries.length > 0
      ? sourceEntries.reduce((sum, entry) => sum + entry.reliabilityLevel, 0) / sourceEntries.length
      : 0;
    const averageTrajectoryScore = sourceEntries.length > 0
      ? sourceEntries.reduce((sum, entry) => sum + entry.trajectoryScore, 0) / sourceEntries.length
      : 0;
    const levelStrength = evidenceLessonCount > 0
      ? ((microLessonCount * 0.4) + (mesoLessonCount * 0.7) + (macroLessonCount * 1.0)) / evidenceLessonCount
      : 0;
    const independentEvidence = Math.min(uniqueSourceEntryCount / 5, 1);
    const trajectoryStrength = Math.min(averageTrajectoryScore / 10, 1);
    const gateScore = Number(Math.max(
      0,
      Math.min(
        1,
        (averageSourceReliability * 0.35)
          + (independentEvidence * 0.25)
          + (levelStrength * 0.25)
          + (trajectoryStrength * 0.15),
      ),
    ).toFixed(3));

    let gateStatus: S2iProposalGateStatus = 'needs_more_evidence';
    if (
      gateScore >= PROMOTION_READY_GATE_THRESHOLD
      && macroLessonCount > 0
      && averageSourceReliability >= 0.85
    ) {
      gateStatus = 'promotion_ready';
    } else if (gateScore >= REVIEW_READY_GATE_THRESHOLD && evidenceLessonCount > 0) {
      gateStatus = 'ready_for_review';
    }

    return {
      evidenceLessonCount,
      uniqueSourceEntryCount,
      microLessonCount,
      mesoLessonCount,
      macroLessonCount,
      averageSourceReliability: Number(averageSourceReliability.toFixed(3)),
      averageTrajectoryScore: Number(averageTrajectoryScore.toFixed(3)),
      gateScore,
      gateStatus,
      contradictionCheckRequired: gateStatus !== 'needs_more_evidence',
    };
  }

  private resolveEvidenceLessonIdsForExcuse(excuse: string): readonly string[] {
    const sourceEntryIds = this.antiRatTriggerSources.get(excuse);
    if (sourceEntryIds && sourceEntryIds.size > 0) {
      return [...new Set(this.lessons
        .filter((lesson) => sourceEntryIds.has(lesson.sourceEntryId))
        .map((lesson) => lesson.lessonId))];
    }

    return this.lessons
      .filter((lesson) => lesson.tags.includes(excuse))
      .map((lesson) => lesson.lessonId);
  }

  private classifyLevel(entry: SuccessLedgerEntry): SamuleLevel {
    if (entry.lessonContext?.levelHint) {
      return entry.lessonContext.levelHint;
    }

    // Macro: high trajectory score + high reliability → transferable insight
    if (entry.trajectoryScore >= MACRO_TRAJECTORY_THRESHOLD && entry.reliabilityLevel >= 0.8) {
      return 'macro';
    }

    // Meso: recurring category (≥2 previous entries with same root cause)
    const categoryEntries = this.entriesByCategory.get(entry.rootCauseCategory) ?? [];
    if (categoryEntries.length >= MESO_RECURRENCE_THRESHOLD) {
      return 'meso';
    }

    // Micro: single-trajectory correction
    return 'micro';
  }

  private generateStatement(entry: SuccessLedgerEntry, level: SamuleLevel): string {
    const explicitPrefix = entry.lessonContext?.statementPrefix;
    const prefix = explicitPrefix ?? (
      level === 'macro'
        ? '[MACRO-INSIGHT]'
        : level === 'meso'
          ? '[MESO-PATTERN]'
          : '[MICRO-FIX]'
    );

    if (explicitPrefix) {
      return `${prefix} ${entry.lessonsLearned}`;
    }

    return `${prefix} ${entry.rootCauseCategory}: ${entry.lessonsLearned}`;
  }

  private generatePrevention(entry: SuccessLedgerEntry): string {
    if (entry.lessonContext?.prevention) {
      return entry.lessonContext.prevention;
    }

    const preventionMap: Record<RootCauseCategory, string> = {
      config: 'Add configuration validation at startup; use IConfigLoader for all config access',
      logic: 'Add unit test for the edge case; consider property-based testing',
      assumption: 'Verify assumptions with tools before acting (Step 2 Elevate dim. 4)',
      environment: 'Check environment prerequisites with shouldAttest() before deployment',
      integration: 'Add integration test; verify DI resolution for all affected tokens',
      missing_test: 'Add test before fix (TDD); check coverage report for gaps',
      architecture: 'Run npm run test:architecture:quick; verify layer boundaries',
      dependency: 'Pin dependency versions; check breaking changes in changelogs',
    };

    return preventionMap[entry.rootCauseCategory] ?? `Investigate ${entry.rootCauseCategory} patterns`;
  }

  private generateTags(entry: SuccessLedgerEntry, level: SamuleLevel): string[] {
    const tags = new Set<string>(entry.lessonContext?.tags ?? []);
    const generatedTags: string[] = [
      entry.rootCauseCategory,
      level,
      `step-${entry.winningStep}`,
    ];

    if (entry.winningFlavor) {
      generatedTags.push(entry.winningFlavor.toLowerCase().replace(/\s+/g, '-'));
    }

    if (level === 'macro') {
      generatedTags.push('MACRO-INSIGHT');
    }

    for (const tag of generatedTags) {
      tags.add(tag);
    }

    return [...tags];
  }
}
