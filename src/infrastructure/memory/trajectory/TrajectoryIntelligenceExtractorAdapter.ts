/**
 * TrajectoryIntelligenceExtractorAdapter — In-memory trajectory intelligence extraction.
 *
 * Analyzes agent reasoning trajectories using heuristic-based classification:
 * - Reasoning type detection via keyword patterns
 * - Cognitive pattern detection via step sequence analysis
 * - Outcome classification based on completion + efficiency
 * - Subtask segmentation via goal-change detection
 *
 * @layer Infrastructure (Memory)
 * @pattern CC-033 Trajectory Intelligence Extractor (TIM arXiv:2603.10600)
 * @see src/domain/memory/ITrajectoryIntelligenceExtractor.ts — domain port
 */

import type {
  ITrajectoryIntelligenceExtractor,
  AgentTrajectory,
  TrajectoryIntelligenceResult,
  TrajectoryExtractionConfig,
  ReasoningStep,
  DetectedPattern,
  TrajectorySubtask,
  TrajectoryOutcomeClassification,
  CognitivePattern,
  ExtractionStats,
  ReasoningType,
} from '../../../domain/memory/ITrajectoryIntelligenceExtractor';
import { DEFAULT_EXTRACTION_CONFIG } from '../../../domain/memory/ITrajectoryIntelligenceExtractor';
import type { ITrajectoryStore } from '../../../domain/memory/ITrajectoryStore';

// ── Keyword Patterns for Classification ───────────────────────────

const REASONING_KEYWORDS: Record<ReasoningType, readonly RegExp[]> = {
  analytical: [/analyz/i, /examin/i, /inspect/i, /investigat/i, /diagnos/i, /read.*file/i, /grep/i, /search/i],
  planning: [/plan/i, /strateg/i, /approach/i, /will.*try/i, /next.*step/i, /let.*me/i, /should.*first/i],
  validation: [/verify/i, /test/i, /confirm/i, /check/i, /assert/i, /pass/i, /fail/i, /run.*test/i],
  reflection: [/reflect/i, /reconsider/i, /wrong.*approach/i, /backtrack/i, /pivoting/i, /didn.*work/i, /try.*different/i],
};

const TOOL_PATTERNS = [
  /(?:ran|called|used|invoked|executed)\s+`?(\w+)`?/i,
  /tool[:\s]+`?(\w+)`?/i,
];

export interface TrajectoryIntelligenceDeps {
  readonly store?: ITrajectoryStore;
  readonly logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

// ── Adapter ───────────────────────────────────────────────────────

export class TrajectoryIntelligenceExtractorAdapter implements ITrajectoryIntelligenceExtractor {
  private readonly results: TrajectoryIntelligenceResult[] = [];
  private readonly hydrationPromise: Promise<void>;
  private idCounter = 0;

  constructor(private readonly deps?: TrajectoryIntelligenceDeps) {
    this.hydrationPromise = deps?.store
      ? this.hydrateResults().catch((error) => {
          // Startup hydration is best-effort; runtime extraction remains available.
          deps.logger?.warn('Trajectory intelligence hydration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
      : Promise.resolve();
  }

  whenReady(): Promise<void> {
    return this.hydrationPromise;
  }

  extractIntelligence(
    trajectory: AgentTrajectory,
    config: TrajectoryExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  ): TrajectoryIntelligenceResult {
    const stepsToAnalyze = trajectory.steps.slice(0, config.maxSteps);

    const reasoningSteps = this.classifySteps(stepsToAnalyze);
    const detectedPatterns = this.detectPatterns(reasoningSteps, config.minPatternConfidence);
    const subtasks = config.enableSubtaskSegmentation
      ? this.segmentSubtasks(reasoningSteps, trajectory)
      : [];
    const efficiencyScore = this.calculateEfficiency(reasoningSteps);
    const recoveryDetected = this.detectRecovery(reasoningSteps);

    const outcomeClassification = this.classifyOutcome(
      trajectory.taskCompleted,
      efficiencyScore,
      recoveryDetected,
      config.efficiencyThreshold,
    );

    const result: TrajectoryIntelligenceResult = {
      trajectoryId: trajectory.trajectoryId,
      outcomeClassification,
      reasoningSteps,
      detectedPatterns,
      subtasks,
      efficiencyScore,
      recoveryDetected,
      analyzedAt: new Date().toISOString(),
    };

    this.mergeResults([result]);
    if (this.deps?.store) {
      void this.deps.store.saveIntelligence(result).catch(() => undefined);
    }
    return result;
  }

  extractBatch(
    trajectories: readonly AgentTrajectory[],
    config: TrajectoryExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  ): readonly TrajectoryIntelligenceResult[] {
    return trajectories.map(t => this.extractIntelligence(t, config));
  }

  getStats(): ExtractionStats {
    const dist: Record<TrajectoryOutcomeClassification, number> = {
      clean_success: 0,
      inefficient_success: 0,
      recovery: 0,
      failure: 0,
    };

    for (const r of this.results) {
      dist[r.outcomeClassification]++;
    }

    const patternCounts = new Map<CognitivePattern, number>();
    for (const r of this.results) {
      for (const p of r.detectedPatterns) {
        patternCounts.set(p.pattern, (patternCounts.get(p.pattern) ?? 0) + 1);
      }
    }

    const topPatterns = [...patternCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p]) => p);

    const avgEfficiency = this.results.length > 0
      ? this.results.reduce((sum, r) => sum + r.efficiencyScore, 0) / this.results.length
      : 0;

    return {
      trajectoriesProcessed: this.results.length,
      outcomeDistribution: dist,
      topPatterns,
      avgEfficiency,
    };
  }

  reset(): void {
    this.results.length = 0;
    this.idCounter = 0;
  }

  private async hydrateResults(): Promise<void> {
    const persisted = await this.deps?.store?.listIntelligence();
    if (!persisted || persisted.length === 0) {
      return;
    }

    this.mergeResults(persisted);
  }

  private mergeResults(results: readonly TrajectoryIntelligenceResult[]): void {
    const existingIds = new Set(this.results.map((result) => result.trajectoryId));
    for (const result of results) {
      if (existingIds.has(result.trajectoryId)) {
        continue;
      }
      this.results.push(result);
      existingIds.add(result.trajectoryId);
    }
  }

  // ── Private ───────────────────────────────────────────────────

  private classifySteps(steps: readonly string[]): ReasoningStep[] {
    return steps.map((step, i) => {
      const reasoningType = this.classifyReasoningType(step);
      const toolUsed = this.extractToolUsed(step);
      const producedNewInfo = this.hasNewInfo(step);
      return { stepIndex: i, reasoningType, description: step, toolUsed, producedNewInfo };
    });
  }

  private classifyReasoningType(step: string): ReasoningType {
    let bestType: ReasoningType = 'analytical';
    let bestScore = 0;

    for (const [type, patterns] of Object.entries(REASONING_KEYWORDS) as [ReasoningType, readonly RegExp[]][]) {
      const score = patterns.filter(p => p.test(step)).length;
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }

    return bestType;
  }

  private extractToolUsed(step: string): string | undefined {
    for (const pattern of TOOL_PATTERNS) {
      const match = pattern.exec(step);
      if (match?.[1]) return match[1];
    }
    return undefined;
  }

  private hasNewInfo(step: string): boolean {
    const negativePhrases = [
      /same.*error/i, /still.*fail/i, /no.*change/i, /already.*tried/i,
      /repeat/i, /unchanged/i,
    ];
    return !negativePhrases.some(p => p.test(step));
  }

  private detectPatterns(
    steps: readonly ReasoningStep[],
    minConfidence: number,
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // Systematic elimination: sequential analytical steps with tool usage
    const analyticalRuns = this.findConsecutiveRuns(steps, 'analytical', 3);
    if (analyticalRuns.length > 0) {
      patterns.push({
        pattern: 'systematic_elimination',
        evidenceSteps: analyticalRuns.flat(),
        confidence: Math.min(1, analyticalRuns.length * 0.3),
      });
    }

    // Hypothesis testing: planning → analytical/validation cycle
    const hypothesisCycles = this.findCycles(steps, ['planning', 'analytical', 'validation']);
    if (hypothesisCycles.length > 0) {
      patterns.push({
        pattern: 'hypothesis_testing',
        evidenceSteps: hypothesisCycles,
        confidence: Math.min(1, hypothesisCycles.length / steps.length + 0.3),
      });
    }

    // Backtracking: reflection steps followed by different approach
    const reflectionIndices = steps
      .filter(s => s.reasoningType === 'reflection')
      .map(s => s.stepIndex);
    if (reflectionIndices.length > 0) {
      patterns.push({
        pattern: 'backtracking',
        evidenceSteps: reflectionIndices,
        confidence: Math.min(1, reflectionIndices.length * 0.25),
      });
    }

    // Trial and error: many steps without new info
    const noInfoSteps = steps.filter(s => !s.producedNewInfo).map(s => s.stepIndex);
    if (noInfoSteps.length > steps.length * 0.3) {
      patterns.push({
        pattern: 'trial_and_error',
        evidenceSteps: noInfoSteps,
        confidence: noInfoSteps.length / steps.length,
      });
    }

    return patterns.filter(p => p.confidence >= minConfidence);
  }

  private findConsecutiveRuns(
    steps: readonly ReasoningStep[],
    type: ReasoningType,
    minLength: number,
  ): number[][] {
    const runs: number[][] = [];
    let current: number[] = [];

    for (const step of steps) {
      if (step.reasoningType === type) {
        current.push(step.stepIndex);
      } else {
        if (current.length >= minLength) runs.push([...current]);
        current = [];
      }
    }
    if (current.length >= minLength) runs.push(current);
    return runs;
  }

  private findCycles(
    steps: readonly ReasoningStep[],
    sequence: readonly ReasoningType[],
  ): number[] {
    const indices: number[] = [];
    let seqIdx = 0;

    for (const step of steps) {
      if (step.reasoningType === sequence[seqIdx]) {
        indices.push(step.stepIndex);
        seqIdx++;
        if (seqIdx >= sequence.length) seqIdx = 0;
      }
    }

    return indices;
  }

  private segmentSubtasks(
    steps: readonly ReasoningStep[],
    trajectory: AgentTrajectory,
  ): TrajectorySubtask[] {
    if (steps.length < 4) return [];

    const subtasks: TrajectorySubtask[] = [];
    let segmentStart = 0;

    for (let i = 1; i < steps.length; i++) {
      const isGoalChange =
        steps[i].reasoningType === 'planning' &&
        steps[i - 1].reasoningType !== 'planning';

      if (isGoalChange || i === steps.length - 1) {
        const endIdx = i === steps.length - 1 ? i : i - 1;
        if (endIdx > segmentStart) {
          const segSteps = steps.slice(segmentStart, endIdx + 1);
          const segEfficiency = this.calculateEfficiency(segSteps);
          const segHasNewInfo = segSteps.some(s => s.producedNewInfo);

          subtasks.push({
            subtaskId: `${trajectory.trajectoryId}-sub-${this.idCounter++}`,
            goal: segSteps[0].description.slice(0, 100),
            startStep: segmentStart,
            endStep: endIdx,
            outcome: segHasNewInfo
              ? (segEfficiency >= 0.6 ? 'clean_success' : 'inefficient_success')
              : 'failure',
          });
        }
        segmentStart = i;
      }
    }

    return subtasks;
  }

  private calculateEfficiency(steps: readonly ReasoningStep[]): number {
    if (steps.length === 0) return 0;
    const infoSteps = steps.filter(s => s.producedNewInfo).length;
    return infoSteps / steps.length;
  }

  private detectRecovery(steps: readonly ReasoningStep[]): boolean {
    let sawFailureSignal = false;
    for (const step of steps) {
      if (step.reasoningType === 'reflection' && !step.producedNewInfo) {
        sawFailureSignal = true;
      }
      if (sawFailureSignal && step.producedNewInfo && step.reasoningType === 'validation') {
        return true;
      }
    }
    return false;
  }

  private classifyOutcome(
    taskCompleted: boolean,
    efficiency: number,
    recoveryDetected: boolean,
    efficiencyThreshold: number,
  ): TrajectoryOutcomeClassification {
    if (!taskCompleted) return 'failure';
    if (recoveryDetected) return 'recovery';
    if (efficiency < efficiencyThreshold) return 'inefficient_success';
    return 'clean_success';
  }
}
