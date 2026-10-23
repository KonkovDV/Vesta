/**
 * ContrastiveLessonLearnerAdapter — In-memory contrastive success/failure analysis.
 *
 * @layer Infrastructure (Memory)
 * @pattern CC-030 Contrastive Lesson Learner (PUA v5.2 → Ebbinghaus 3.0)
 * @see src/domain/memory/IContrastiveLessonLearner.ts — domain port
 */

import type {
  IContrastiveLessonLearner,
  ContrastiveTrajectoryEntry,
  DiscriminatingFactor,
  AntiPattern,
  ContrastiveConfig,
  ContrastiveStats,
  ParentSelectionCandidate,
  ParentSelectionConfig,
  ParentSelectionResult,
} from '../../domain/memory/IContrastiveLessonLearner';
import {
  DEFAULT_CONTRASTIVE_CONFIG,
  DEFAULT_PARENT_SELECTION_CONFIG,
} from '../../domain/memory/IContrastiveLessonLearner';
import type { ITrajectoryStore } from '../../domain/memory/ITrajectoryStore';

// ── Logger ────────────────────────────────────────────────────────

interface LearnerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

export class ContrastiveLessonLearnerAdapter implements IContrastiveLessonLearner {
  private readonly trajectories: ContrastiveTrajectoryEntry[] = [];
  private readonly antiPatterns: AntiPattern[] = [];
  private readonly deadCategories = new Set<string>();
  private idCounter = 0;
  private readonly trajectoryStore: ITrajectoryStore | undefined;

  constructor(
    private readonly logger?: LearnerLogger,
    trajectoryStore?: ITrajectoryStore,
    private readonly random: () => number = Math.random,
  ) {
    this.trajectoryStore = trajectoryStore;
  }

  addTrajectory(entry: ContrastiveTrajectoryEntry): void {
    this.trajectories.push(entry);
    if (this.trajectoryStore) {
      void this.trajectoryStore.saveContrastiveTrajectory(entry).catch((error) => {
        this.logger?.warn('Contrastive trajectory persistence failed', {
          id: entry.trajectoryId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.logger?.info('Trajectory added', {
      id: entry.trajectoryId,
      category: entry.rootCauseCategory,
      outcome: entry.outcome,
      factors: entry.factors.length,
    });
  }

  analyzeCategory(
    rootCauseCategory: string,
    config: ContrastiveConfig = DEFAULT_CONTRASTIVE_CONFIG,
  ): readonly AntiPattern[] {
    const categoryEntries = this.trajectories.filter(
      t => t.rootCauseCategory === rootCauseCategory,
    );

    if (categoryEntries.length < config.minTrajectories) {
      // Adaptive threshold: if discrimination is strong enough, lower requirement
      if (config.adaptiveThreshold && categoryEntries.length >= 2) {
        const successes = categoryEntries.filter(t => t.outcome === 'success');
        const failures = categoryEntries.filter(t => t.outcome === 'failure');
        if (failures.length < config.minFailures || successes.length === 0) return [];
        // Only proceed if we find strong discrimination
        const factors = this.findDiscriminatingFactors(successes, failures, 0.7);
        if (factors.length === 0) return [];
        // Fall through to normal analysis with relaxed threshold
      } else {
        return [];
      }
    }

    const successes = categoryEntries.filter(t => t.outcome === 'success');
    const failures = categoryEntries.filter(t => t.outcome === 'failure');

    if (failures.length < config.minFailures) return [];
    if (successes.length === 0) return [];

    // Group by operation type
    const opTypes = new Set(categoryEntries.map(t => t.operationType));
    const generated: AntiPattern[] = [];

    for (const opType of opTypes) {
      const opSuccesses = successes.filter(t => t.operationType === opType);
      const opFailures = failures.filter(t => t.operationType === opType);

      if (opFailures.length < config.minFailures || opSuccesses.length === 0) continue;

      // Extract discriminating factors
      const factors = this.findDiscriminatingFactors(
        opSuccesses, opFailures, config.discriminationThreshold,
      );

      if (factors.length === 0) continue;

      // Calculate confidence
      const totalTrajectories = opSuccesses.length + opFailures.length;
      const avgDiscrimination = factors.reduce((s, f) => s + f.discriminationStrength, 0) / factors.length;
      const sampleBonus = Math.min(totalTrajectories / 10, 0.3);
      const confidence = Math.min(avgDiscrimination + sampleBonus, 1.0);

      if (confidence < config.confidenceThreshold) continue;

      const failureConditions = factors
        .filter(f => f.direction === 'failure_marker')
        .map(f => f.factor);

      const prevention = factors
        .filter(f => f.direction === 'success_marker')
        .map(f => `Ensure "${f.factor}" is present (found in ${(f.successFrequency * 100).toFixed(0)}% of successes)`);

      const statement = this.synthesizeStatement(rootCauseCategory, opType, factors);

      const antiPattern: AntiPattern = {
        antiPatternId: `ap-${++this.idCounter}`,
        rootCauseCategory,
        operationType: opType,
        statement,
        discriminatingFactors: factors,
        failureConditions,
        prevention,
        successCount: opSuccesses.length,
        failureCount: opFailures.length,
        confidence,
        generatedAt: new Date().toISOString(),
      };

      generated.push(antiPattern);
      this.antiPatterns.push(antiPattern);

      this.logger?.info('Anti-pattern generated', {
        id: antiPattern.antiPatternId,
        category: rootCauseCategory,
        opType,
        confidence,
        factors: factors.length,
      });
    }

    return generated;
  }

  analyzeAll(config: ContrastiveConfig = DEFAULT_CONTRASTIVE_CONFIG): readonly AntiPattern[] {
    const categories = new Set(this.trajectories.map(t => t.rootCauseCategory));
    const allPatterns: AntiPattern[] = [];

    for (const category of categories) {
      const patterns = this.analyzeCategory(category, config);
      if (patterns.length === 0) {
        this.deadCategories.add(category);
      } else {
        this.deadCategories.delete(category);
      }
      allPatterns.push(...patterns);
    }

    return allPatterns;
  }

  async selectParentTrajectory(
    rootCauseCategory: string,
    config: ParentSelectionConfig = DEFAULT_PARENT_SELECTION_CONFIG,
  ): Promise<ParentSelectionResult | undefined> {
    const categoryEntries = await this.loadCategoryEntries(rootCauseCategory);
    const candidates = categoryEntries.filter((entry) =>
      entry.rootCauseCategory === rootCauseCategory
      && (config.operationType ? entry.operationType === config.operationType : true)
      && entry.canSelectParent !== false
      && entry.reliabilityLevel >= config.minReliabilityLevel
      && entry.trajectoryScore >= config.minTrajectoryScore,
    );

    if (candidates.length === 0) {
      return undefined;
    }

    const childCounts = this.computeChildCounts(categoryEntries);
    const scoredCandidates = this.scoreCandidates(candidates, childCounts, config);
    const selected = this.chooseCandidate(scoredCandidates, config);

    this.logger?.info('Parent trajectory selected', {
      category: rootCauseCategory,
      strategy: config.strategy,
      selectedId: selected.trajectoryId,
      candidateCount: scoredCandidates.length,
    });

    return {
      rootCauseCategory,
      strategy: config.strategy,
      selected,
      candidates: scoredCandidates,
      selectedAt: new Date().toISOString(),
    };
  }

  getAntiPatterns(): readonly AntiPattern[] {
    return [...this.antiPatterns];
  }

  getStats(): ContrastiveStats {
    const categories = new Set(this.trajectories.map(t => t.rootCauseCategory));
    return {
      totalTrajectories: this.trajectories.length,
      successCount: this.trajectories.filter(t => t.outcome === 'success').length,
      failureCount: this.trajectories.filter(t => t.outcome === 'failure').length,
      antiPatternsGenerated: this.antiPatterns.length,
      categoriesAnalyzed: categories.size,
      deadTrajectoryCategories: this.deadCategories.size,
    };
  }

  reset(): void {
    this.trajectories.length = 0;
    this.antiPatterns.length = 0;
    this.deadCategories.clear();
    this.idCounter = 0;
    this.logger?.info('Contrastive Lesson Learner reset');
  }

  // ── Private Helpers ─────────────────────────────────────────

  private async loadCategoryEntries(rootCauseCategory: string): Promise<readonly ContrastiveTrajectoryEntry[]> {
    const persisted = this.trajectoryStore
      ? await this.trajectoryStore.listContrastiveByCategory(rootCauseCategory)
      : [];
    return this.mergeTrajectories(this.trajectories, persisted);
  }

  private mergeTrajectories(
    current: readonly ContrastiveTrajectoryEntry[],
    persisted: readonly ContrastiveTrajectoryEntry[],
  ): readonly ContrastiveTrajectoryEntry[] {
    const merged = new Map<string, ContrastiveTrajectoryEntry>();

    for (const entry of [...persisted, ...current]) {
      merged.set(entry.trajectoryId, entry);
    }

    return [...merged.values()];
  }

  private computeChildCounts(
    entries: readonly ContrastiveTrajectoryEntry[],
  ): ReadonlyMap<string, number> {
    const childCounts = new Map<string, number>();

    for (const entry of entries) {
      childCounts.set(entry.trajectoryId, childCounts.get(entry.trajectoryId) ?? 0);
      if (!entry.parentTrajectoryId) {
        continue;
      }
      childCounts.set(
        entry.parentTrajectoryId,
        (childCounts.get(entry.parentTrajectoryId) ?? 0) + 1,
      );
    }

    return childCounts;
  }

  private scoreCandidates(
    candidates: readonly ContrastiveTrajectoryEntry[],
    childCounts: ReadonlyMap<string, number>,
    config: ParentSelectionConfig,
  ): ParentSelectionCandidate[] {
    const baseScores = candidates.map((entry) => this.computeBaseScore(entry));
    const midpoint = this.computeTopMidpoint(baseScores);

    const scored = candidates.map((entry, index) => {
      const childCount = childCounts.get(entry.trajectoryId) ?? 0;
      const baseScore = baseScores[index] ?? 0;
      const proportionalScore = this.logisticScore(baseScore, midpoint);
      const childPenalty = config.strategy === 'score_child_prop'
        ? this.computeChildPenalty(childCount, config.childPenaltyScale)
        : 1;
      const finalScore = config.strategy === 'best'
        ? baseScore
        : Math.max(0, Math.min(1, proportionalScore * childPenalty));
      const selectionWeight = config.strategy === 'best'
        ? finalScore
        : Math.max(0.0001, finalScore);

      return {
        trajectoryId: entry.trajectoryId,
        rootCauseCategory: entry.rootCauseCategory,
        operationType: entry.operationType,
        parentTrajectoryId: entry.parentTrajectoryId,
        childCount,
        baseScore,
        finalScore,
        selectionWeight,
        trajectoryScore: entry.trajectoryScore,
        reliabilityLevel: entry.reliabilityLevel,
      } satisfies ParentSelectionCandidate;
    });

    scored.sort((left, right) =>
      right.finalScore - left.finalScore
      || right.trajectoryScore - left.trajectoryScore
      || right.reliabilityLevel - left.reliabilityLevel,
    );

    return scored;
  }

  private chooseCandidate(
    candidates: readonly ParentSelectionCandidate[],
    config: ParentSelectionConfig,
  ): ParentSelectionCandidate {
    if (candidates.length === 0) {
      throw new Error('No parent selection candidates available');
    }

    if (config.strategy === 'best' || candidates.length === 1) {
      return candidates[0];
    }

    const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.selectionWeight, 0);
    if (totalWeight <= 0) {
      return candidates[0];
    }

    const threshold = this.random() * totalWeight;
    let cumulative = 0;
    for (const candidate of candidates) {
      cumulative += candidate.selectionWeight;
      if (threshold <= cumulative) {
        return candidate;
      }
    }

    return candidates[candidates.length - 1];
  }

  private computeBaseScore(entry: ContrastiveTrajectoryEntry): number {
    const normalizedTrajectoryScore = Math.max(0, Math.min(1, entry.trajectoryScore / 10));
    return Math.max(0, Math.min(1, normalizedTrajectoryScore * 0.7 + entry.reliabilityLevel * 0.3));
  }

  private computeTopMidpoint(scores: readonly number[]): number {
    if (scores.length === 0) {
      return 0;
    }

    const topScores = [...scores].sort((left, right) => right - left).slice(0, 3);
    return topScores.reduce((sum, score) => sum + score, 0) / topScores.length;
  }

  private logisticScore(score: number, midpoint: number): number {
    return 1 / (1 + Math.exp(-10 * (score - midpoint)));
  }

  private computeChildPenalty(childCount: number, scale: number): number {
    const safeScale = Math.max(scale, 0.0001);
    return Math.exp(-Math.pow(childCount / safeScale, 3));
  }

  private findDiscriminatingFactors(
    successes: readonly ContrastiveTrajectoryEntry[],
    failures: readonly ContrastiveTrajectoryEntry[],
    threshold: number,
  ): DiscriminatingFactor[] {
    // Collect all unique factors
    const allFactors = new Set<string>();
    for (const t of [...successes, ...failures]) {
      for (const f of t.factors) allFactors.add(f);
    }

    const factors: DiscriminatingFactor[] = [];

    for (const factor of allFactors) {
      const successFreq = successes.filter(t => t.factors.includes(factor)).length / successes.length;
      const failureFreq = failures.filter(t => t.factors.includes(factor)).length / failures.length;
      const strength = Math.abs(successFreq - failureFreq);

      if (strength >= threshold) {
        factors.push({
          factor,
          successFrequency: successFreq,
          failureFrequency: failureFreq,
          discriminationStrength: strength,
          direction: successFreq > failureFreq ? 'success_marker' : 'failure_marker',
        });
      }
    }

    // Sort by discrimination strength descending
    factors.sort((a, b) => b.discriminationStrength - a.discriminationStrength);
    return factors;
  }

  private synthesizeStatement(
    category: string,
    opType: string,
    factors: readonly DiscriminatingFactor[],
  ): string {
    const failureMarkers = factors
      .filter(f => f.direction === 'failure_marker')
      .map(f => f.factor);
    const successMarkers = factors
      .filter(f => f.direction === 'success_marker')
      .map(f => f.factor);

    const parts = [`ANTI-PATTERN [${category}/${opType}]:`];
    if (failureMarkers.length > 0) {
      parts.push(`Avoid: ${failureMarkers.join(', ')}.`);
    }
    if (successMarkers.length > 0) {
      parts.push(`Require: ${successMarkers.join(', ')}.`);
    }

    return parts.join(' ');
  }
}
