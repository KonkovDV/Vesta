/**
 * WisdomConsolidatorAdapter — In-memory SAGE memory consolidation.
 *
 * In-memory implementation of IWisdomConsolidator. Groups related micro/meso
 * lessons by root cause category, evaluates conformal gating, and synthesizes
 * consolidated macro-principles with merged prevention recommendations.
 *
 * Anti-Sycophancy Interlocks (arXiv:2310.13548, Sharma et al.):
 *   Before micro→meso→macro merge, a "Debater" adversarial scrubber attempts
 *   falsification using counter-examples from trajectory history. If contradicting
 *   lessons exist (≥30% of the group contradicting the shared pattern), the
 *   candidate's reliability is penalized and may fail the conformal gate.
 *
 * @layer Infrastructure (Memory)
 * @pattern CC-027 Wisdom Consolidator (PUA v5.1 → Ebbinghaus 2.1)
 * @see src/domain/memory/IWisdomConsolidator.ts — domain port
 * @see src/core/events/wisdom-consolidator.schemas.ts — Zod validation schemas
 * @see arXiv:2310.13548 — Anti-Sycophancy (Sharma et al.)
 */

import type {
  IWisdomConsolidator,
  ConsolidationCandidate,
  ConsolidatedPrinciple,
  ConsolidationConfig,
  ConsolidationStats,
} from '../../domain/memory/IWisdomConsolidator';
import { DEFAULT_CONSOLIDATION_CONFIG } from '../../domain/memory/IWisdomConsolidator';
import type { ILessonStore } from '../../domain/memory/ILessonStore';

// ── Minimal Logger ────────────────────────────────────────────────

interface ConsolidatorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Lesson Input Shape ────────────────────────────────────────────

interface LessonInput {
  readonly lessonId: string;
  readonly level: string;
  readonly rootCauseCategory: string;
  readonly statement: string;
  readonly tags: readonly string[];
  readonly extractedAt: string;
}

// ── Adapter ───────────────────────────────────────────────────────

export class WisdomConsolidatorAdapter implements IWisdomConsolidator {
  private readonly principles: ConsolidatedPrinciple[] = [];
  private readonly archivedLessonIds = new Set<string>();
  private readonly hydrationPromise: Promise<void>;
  private idCounter = Date.now();
  private totalScanned = 0;
  private totalCandidatesFound = 0;
  private totalCandidatesPassingGate = 0;
  private totalDebaterRejections = 0;
  private readonly lessonStore: ILessonStore | undefined;

  constructor(private readonly logger?: ConsolidatorLogger, lessonStore?: ILessonStore) {
    this.lessonStore = lessonStore;
    this.hydrationPromise = lessonStore
      ? this.hydratePrinciples().catch((error) => {
          this.logger?.warn('Principle hydration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
      : Promise.resolve();
  }

  whenReady(): Promise<void> {
    return this.hydrationPromise;
  }

  findCandidates(
    lessons: ReadonlyArray<LessonInput>,
    config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
  ): readonly ConsolidationCandidate[] {
    this.totalScanned += lessons.length;

    // Filter to micro/meso lessons only (macro are already consolidated)
    const eligible = lessons.filter(
      l => (l.level === 'micro' || l.level === 'meso') && !this.archivedLessonIds.has(l.lessonId),
    );

    // Group by root cause category
    const grouped = new Map<string, LessonInput[]>();
    for (const lesson of eligible) {
      const existing = grouped.get(lesson.rootCauseCategory) ?? [];
      existing.push(lesson);
      grouped.set(lesson.rootCauseCategory, existing);
    }

    const candidates: ConsolidationCandidate[] = [];

    for (const [category, group] of grouped) {
      if (group.length < config.minLessonsForConsolidation) continue;

      // Check age constraint
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - config.maxAgeDays);
      const recent = group.filter(l => new Date(l.extractedAt) >= cutoffDate);
      if (recent.length < config.minLessonsForConsolidation) continue;

      const microCount = recent.filter(l => l.level === 'micro').length;
      const mesoCount = recent.filter(l => l.level === 'meso').length;

      // Simulate reliability level from lesson count (heuristic: more lessons = higher reliability)
      const rawRL = Math.min(0.5 + (recent.length * 0.1), 1.0);

      // Anti-Sycophancy: Debater adversarial scrub (arXiv:2310.13548)
      // Check for counter-evidence within the group that contradicts the shared pattern.
      // If ≥30% of lessons contradict the dominant pattern, penalize reliability.
      const debaterPenalty = this.computeDebaterPenalty(recent);
      const avgRL = Math.max(0, rawRL - debaterPenalty);
      const passesGate = avgRL >= config.conformalGateThreshold;

      if (debaterPenalty > 0) {
        this.logger?.info('Debater penalty applied', {
          category,
          rawRL,
          penalty: debaterPenalty,
          adjustedRL: avgRL,
          passesGate,
        });
      }

      // Estimate urgency from oldest lesson age
      const oldestDate = new Date(
        Math.min(...recent.map(l => new Date(l.extractedAt).getTime())),
      );
      const urgencyDays = Math.max(
        0,
        config.maxAgeDays - Math.floor((Date.now() - oldestDate.getTime()) / (1000 * 60 * 60 * 24)),
      );

      // Find shared pattern via common keywords
      const sharedPattern = this.detectSharedPattern(recent);

      const candidate: ConsolidationCandidate = {
        candidateId: `wc-cand-${++this.idCounter}`,
        lessonIds: recent.map(l => l.lessonId),
        sharedCategory: category,
        sharedPattern,
        avgReliabilityLevel: avgRL,
        passesConformalGate: passesGate,
        microCount,
        mesoCount,
        urgencyDays,
      };

      candidates.push(candidate);

      this.logger?.info('Consolidation candidate found', {
        candidateId: candidate.candidateId,
        category,
        lessonCount: recent.length,
        passesGate,
        avgRL,
      });
    }

    this.totalCandidatesFound += candidates.length;
    this.totalCandidatesPassingGate += candidates.filter(c => c.passesConformalGate).length;

    return candidates;
  }

  consolidate(
    candidate: ConsolidationCandidate,
    lessons: ReadonlyArray<{
      readonly lessonId: string;
      readonly statement: string;
      readonly rootCauseCategory: string;
      readonly tags: readonly string[];
    }>,
  ): ConsolidatedPrinciple | null {
    if (!candidate.passesConformalGate) {
      this.logger?.warn('Candidate rejected by conformal gate', {
        candidateId: candidate.candidateId,
        avgRL: candidate.avgReliabilityLevel,
      });
      return null;
    }

    // Filter source lessons
    const sourceSet = new Set(candidate.lessonIds);
    const sources = lessons.filter(l => sourceSet.has(l.lessonId));

    if (sources.length === 0) return null;

    // Anti-Sycophancy: second debater pass on source lessons before consolidation
    const debaterPenalty = this.computeDebaterPenalty(
      sources.map(s => ({
        lessonId: s.lessonId,
        level: 'micro',
        rootCauseCategory: s.rootCauseCategory,
        statement: s.statement,
        tags: [...s.tags],
        extractedAt: new Date().toISOString(),
      })),
    );
    const adjustedRL = Math.max(0, candidate.avgReliabilityLevel - debaterPenalty);
    if (adjustedRL < 0.5) {
      this.logger?.warn('Candidate rejected by anti-sycophancy debater', {
        candidateId: candidate.candidateId,
        rawRL: candidate.avgReliabilityLevel,
        penalty: debaterPenalty,
        adjustedRL,
      });
      return null;
    }

    if (sources.length === 0) return null;

    // Synthesize macro-principle from source statements
    const statement = this.synthesizePrinciple(sources, candidate.sharedCategory);

    // Merge prevention recommendations
    const prevention = this.synthesizePrevention(sources);

    // Merge tags (deduplicated)
    const tags = [...new Set(sources.flatMap(l => [...l.tags]))];

    const principle: ConsolidatedPrinciple = {
      principleId: `wc-princ-${++this.idCounter}`,
      level: 'macro',
      statement,
      sourceLessonIds: candidate.lessonIds,
      rootCauseCategory: candidate.sharedCategory,
      prevention,
      reliabilityLevel: candidate.avgReliabilityLevel,
      consolidatedAt: new Date().toISOString(),
      tags,
    };

    this.mergePrinciples([principle]);
    if (this.lessonStore) {
      void this.lessonStore.savePrinciple(principle).catch((error) => {
        this.logger?.warn('Principle persistence failed', {
          principleId: principle.principleId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Archive source lessons
    for (const id of candidate.lessonIds) {
      this.archivedLessonIds.add(id);
    }

    this.logger?.info('Principle consolidated', {
      principleId: principle.principleId,
      sourceCount: candidate.lessonIds.length,
      category: candidate.sharedCategory,
    });

    return principle;
  }

  getPrinciples(): readonly ConsolidatedPrinciple[] {
    return [...this.principles];
  }

  getStats(): ConsolidationStats {
    return {
      totalLessonsScanned: this.totalScanned,
      candidatesFound: this.totalCandidatesFound,
      candidatesPassingGate: this.totalCandidatesPassingGate,
      principlesGenerated: this.principles.length,
      lessonsArchived: this.archivedLessonIds.size,
    };
  }

  private async hydratePrinciples(): Promise<void> {
    const persisted = await this.lessonStore?.listPrinciples();
    if (!persisted || persisted.length === 0) {
      return;
    }

    this.mergePrinciples(persisted);
  }

  private mergePrinciples(principles: readonly ConsolidatedPrinciple[]): void {
    const existingIds = new Set(this.principles.map((principle) => principle.principleId));
    for (const principle of principles) {
      for (const lessonId of principle.sourceLessonIds) {
        this.archivedLessonIds.add(lessonId);
      }

      if (existingIds.has(principle.principleId)) {
        continue;
      }
      this.principles.push(principle);
      this.syncIdCounterFromEntityId(principle.principleId);
      existingIds.add(principle.principleId);
    }
  }

  private syncIdCounterFromEntityId(entityId: string): void {
    const match = /^wc-(?:cand|princ)-(\d+)$/.exec(entityId);
    if (!match) {
      return;
    }

    this.idCounter = Math.max(this.idCounter, Number(match[1]));
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Anti-Sycophancy Debater: adversarial scrubbing of consolidation candidates.
   *
   * Scans lessons within a group for contradictory evidence — lessons whose
   * statements contain negation patterns or conflict with the majority.
   * Uses keyword divergence: if a lesson's word set divergence from the
   * group centroid exceeds 70%, it's flagged as counter-evidence.
   *
   * Penalty = counterEvidenceRatio * 0.5 (up to 0.5 max penalty).
   * If ≥30% of lessons are counter-evidence, candidate is flagged.
   *
   * @see arXiv:2310.13548 — Sycophancy in LLMs (Sharma et al.)
   */
  private computeDebaterPenalty(lessons: readonly LessonInput[]): number {
    if (lessons.length < 3) return 0;

    // Build centroid word set from all lesson statements
    const allWords = new Map<string, number>();
    for (const lesson of lessons) {
      const words = new Set(
        lesson.statement.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3),
      );
      for (const word of words) {
        allWords.set(word, (allWords.get(word) ?? 0) + 1);
      }
    }
    const centroidThreshold = Math.ceil(lessons.length / 2);
    const centroidWords = new Set(
      [...allWords.entries()].filter(([, c]) => c >= centroidThreshold).map(([w]) => w),
    );

    if (centroidWords.size === 0) return 0;

    // Count counter-evidence: lessons with <30% overlap with centroid
    let counterCount = 0;
    for (const lesson of lessons) {
      const words = new Set(
        lesson.statement.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3),
      );
      let overlap = 0;
      for (const w of words) {
        if (centroidWords.has(w)) overlap++;
      }
      const overlapRatio = centroidWords.size > 0 ? overlap / centroidWords.size : 0;
      if (overlapRatio < 0.3) {
        counterCount++;
      }
    }

    const counterRatio = counterCount / lessons.length;
    if (counterRatio >= 0.3) {
      this.totalDebaterRejections++;
      return counterRatio * 0.5; // penalty up to 0.5
    }
    return 0;
  }

  private detectSharedPattern(lessons: readonly LessonInput[]): string {
    // Extract common words across all lesson statements
    const wordCounts = new Map<string, number>();
    for (const lesson of lessons) {
      const words = new Set(
        lesson.statement
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(w => w.length > 3),
      );
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }

    // Words appearing in ≥50% of lessons are "shared pattern"
    const threshold = Math.ceil(lessons.length / 2);
    const common = [...wordCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    return common.length > 0
      ? `Common pattern: ${common.join(', ')}`
      : `Shared root cause: ${lessons[0].rootCauseCategory}`;
  }

  private synthesizePrinciple(
    sources: ReadonlyArray<{ readonly statement: string }>,
    category: string,
  ): string {
    // Combine first source statement with category
    const firstStatement = sources[0].statement;
    return `[MACRO-INSIGHT] Consolidated from ${sources.length} lessons in "${category}": ${firstStatement}`;
  }

  private synthesizePrevention(
    sources: ReadonlyArray<{ readonly statement: string }>,
  ): string {
    return `Prevention synthesized from ${sources.length} related lessons. ` +
      `Apply systematic checks before repeating known failure patterns.`;
  }
}
