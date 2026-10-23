/**
 * LlmTrajectoryIntelligenceAdapter — LLM-enhanced trajectory intelligence extraction.
 *
 * Upgrades the heuristic CC-033 extractor with IModelRouter (KC-025) integration,
 * structured prompts from arXiv:2603.10600 §3.1, and an async LLM extraction path.
 *
 * When IModelRouter is injected:
 *   - PROMPTS templates target 4 analytical dimensions (reasoning, cognitive, outcome, subtask)
 *   - buildPrompts() generates inspection-ready prompts for debugging/testing
 *   - extractWithLlmAsync() selects optimal model via IModelRouter and constructs prompts
 *   - Sync extractIntelligence() uses heuristic fallback for backward compatibility
 *
 * Entropy-Driven Audit Triggers (arXiv:2601.15690):
 *   Computes extraction entropy from trajectory step variance. High entropy
 *   (>0.7) indicates uncertain extraction quality and triggers a PROBE request
 *   (arXiv:2510.19771) for user clarification.
 *
 * @layer Infrastructure (Memory)
 * @pattern CC-033 Trajectory Intelligence Extractor — LLM variant (TIM arXiv:2603.10600 §3.1)
 * @see src/domain/memory/ITrajectoryIntelligenceExtractor.ts — domain port
 * @see src/infrastructure/memory/trajectory/TrajectoryIntelligenceExtractorAdapter.ts — heuristic fallback
 * @see arXiv:2601.15690 — Uncertainty as Metacognitive Control
 * @see arXiv:2510.19771 — PROBE (gap between search & resolve)
 */

import type {
  ITrajectoryIntelligenceExtractor,
  AgentTrajectory,
  TrajectoryIntelligenceResult,
  TrajectoryExtractionConfig,
  ExtractionStats,
  ReasoningType,
  CognitivePattern,
  TrajectoryOutcomeClassification,
  DetectedPattern,
  TrajectorySubtask,
} from '../../../domain/memory/ITrajectoryIntelligenceExtractor';
import { DEFAULT_EXTRACTION_CONFIG } from '../../../domain/memory/ITrajectoryIntelligenceExtractor';
import { TrajectoryIntelligenceExtractorAdapter } from './TrajectoryIntelligenceExtractorAdapter';
import type { IModelRouter, ModelSelection } from '../../../domain/ai/IModelRouter';
import type { ILLMAdapterFactory } from '../../../domain/ai/ILLMAdapterFactory';
import type { ITrajectoryStore } from '../../../domain/memory/ITrajectoryStore';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';

// ── Prompt Templates (arXiv:2603.10600 §3.1) ─────────────────────

/**
 * Structured prompts for LLM-based trajectory analysis.
 * Each template targets a specific analytical dimension from the paper.
 */
const PROMPTS = {
  /** Classifies cognitive nature of an agent action. */
  reasoningType: (step: string): string =>
    `Classify this agent reasoning step into one category:\n` +
    `- analytical: examining data, reading errors, breaking down problems\n` +
    `- planning: outlining approach, defining steps, setting strategy\n` +
    `- validation: testing, verifying, checking results\n` +
    `- reflection: evaluating past actions, reconsidering approach\n\n` +
    `Step: "${step}"\nCategory:`,

  /** Detects higher-order strategies in a step sequence. */
  cognitivePattern: (steps: readonly string[]): string =>
    `Identify cognitive patterns in this agent reasoning sequence.\n` +
    `Patterns: systematic_elimination, divide_and_conquer, hypothesis_testing, ` +
    `pattern_recognition, backtracking, trial_and_error.\n\n` +
    `Steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nDetected patterns:`,

  /** Nuanced outcome assessment beyond binary success/failure. */
  outcomeAssessment: (task: string, stepCount: number, success: boolean): string =>
    `Assess this trajectory outcome.\nTask: "${task}"\nSteps: ${stepCount}\n` +
    `Success: ${success}\n\nClassify as: clean_success | inefficient_success | ` +
    `recovery_success | failure.\nRate efficiency (0.0-1.0).\nAssessment:`,

  /** Segments trajectory by intent shifts (not position). */
  subtaskSegmentation: (steps: readonly string[]): string =>
    `Segment these agent steps into logical subtasks based on intent shifts.\n\n` +
    `Steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
    `Return: [start-end] description`,
} as const;

// ── Dependencies ──────────────────────────────────────────────────

/** Optional dependencies for LLM-enhanced extraction. */
export interface LlmExtractionDeps {
  /** Model router for LLM selection. When absent, falls back to heuristic. */
  readonly modelRouter?: IModelRouter;
  /** Optional LLM factory for real inference after routing. */
  readonly llmFactory?: ILLMAdapterFactory;
  /** Optional durable store shared with heuristic fallback. */
  readonly trajectoryStore?: ITrajectoryStore;
  /** Optional operator-facing logger for PROBE notifications. */
  readonly logger?: Pick<IStructuredLogger, 'warn'>;
}

interface ParsedLlmTrajectoryAnalysis {
  readonly outcomeClassification?: TrajectoryOutcomeClassification;
  readonly reasoningTypes?: readonly ReasoningType[];
  readonly detectedPatterns?: readonly DetectedPattern[];
  readonly subtasks?: readonly TrajectorySubtask[];
  readonly efficiencyScore?: number;
  readonly recoveryDetected?: boolean;
}

const REASONING_TYPES: readonly ReasoningType[] = [
  'analytical',
  'planning',
  'validation',
  'reflection',
];

const COGNITIVE_PATTERNS: readonly CognitivePattern[] = [
  'systematic_elimination',
  'divide_and_conquer',
  'hypothesis_testing',
  'pattern_recognition',
  'backtracking',
  'trial_and_error',
];

const OUTCOME_CLASSIFICATIONS: readonly TrajectoryOutcomeClassification[] = [
  'clean_success',
  'inefficient_success',
  'recovery',
  'failure',
];

/** Result of entropy analysis with optional PROBE trigger. */
export interface EntropyAnalysis {
  /** Shannon entropy of reasoning type distribution (0-1 normalized). */
  readonly entropy: number;
  /** Whether entropy exceeds the PROBE trigger threshold (>0.7). */
  readonly probeTriggered: boolean;
  /** Suggested clarification question if PROBE triggered. */
  readonly clarificationRequest?: string;
  /** Variance of step lengths (proxy for logprob variance). */
  readonly stepLengthVariance: number;
  /** Normalized step-length variance [0, 1] — first-class metric for trajectory quality. */
  readonly normalizedVariance: number;
}

export interface ProbeTriggerNotification {
  readonly trajectoryId: string;
  readonly taskDescription: string;
  readonly analysis: EntropyAnalysis & {
    readonly probeTriggered: true;
    readonly clarificationRequest: string;
  };
}

type ProbeTriggerListener = (notification: ProbeTriggerNotification) => void | Promise<void>;

// ── Adapter ───────────────────────────────────────────────────

export class LlmTrajectoryIntelligenceAdapter implements ITrajectoryIntelligenceExtractor {
  private readonly heuristicFallback: TrajectoryIntelligenceExtractorAdapter;
  private readonly modelRouter: IModelRouter | undefined;
  private readonly llmFactory: ILLMAdapterFactory | undefined;
  private readonly logger: Pick<IStructuredLogger, 'warn'> | undefined;
  private readonly probeListeners = new Set<ProbeTriggerListener>();
  private extractionCount = 0;
  private llmEnhancedCount = 0;
  private probeTriggeredCount = 0;
  private lastEntropyAnalysis: EntropyAnalysis | undefined;
  private lastModelSelection: ModelSelection | undefined;

  constructor(deps?: LlmExtractionDeps) {
    this.heuristicFallback = new TrajectoryIntelligenceExtractorAdapter({ store: deps?.trajectoryStore });
    this.modelRouter = deps?.modelRouter;
    this.llmFactory = deps?.llmFactory;
    this.logger = deps?.logger;
  }

  /** Whether LLM model router is available for enhanced extraction. */
  get llmAvailable(): boolean {
    return this.modelRouter !== undefined;
  }

  extractIntelligence(
    trajectory: AgentTrajectory,
    config: TrajectoryExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  ): TrajectoryIntelligenceResult {
    this.extractionCount++;
    const result = this.heuristicFallback.extractIntelligence(trajectory, config);

    const entropyAnalysis = this.recordEntropyAnalysis(trajectory, result);

    return { ...result, normalizedVariance: entropyAnalysis.normalizedVariance };
  }

  /**
   * LLM-enhanced extraction (async path).
   *
   * When IModelRouter is available:
   *   1. Selects optimal model via IModelRouter.selectModel() (real routing)
   *   2. Resolves an LLM adapter via ILLMAdapterFactory.createAdapterWithFailover()
   *   3. Performs real inference through ILLMAdapter.generateText()
   *   4. Merges validated LLM output into the heuristic extraction result
   *
   * If LLM inference or parsing fails, the adapter logs and falls back to the
   * heuristic extractor to preserve deterministic availability.
   */
  async extractWithLlmAsync(
    trajectory: AgentTrajectory,
    config: TrajectoryExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  ): Promise<TrajectoryIntelligenceResult> {
    this.extractionCount++;

    const modelRouter = this.modelRouter;
    if (modelRouter) {
      this.llmEnhancedCount++;

      // Real model routing: select optimal model for trajectory analysis
      this.lastModelSelection = await modelRouter.selectModel({
        taskComplexity: 'complex',
        requiredCapabilities: ['reasoning'],
        correlationId: trajectory.trajectoryId,
      });

      const heuristicResult = this.heuristicFallback.extractIntelligence(trajectory, config);
      const llmFactory = this.llmFactory;
      if (llmFactory) {
        try {
          const prompt = this.buildLlmExtractionPrompt(trajectory);
          const { adapter } = await llmFactory.createAdapterWithFailover(
            this.lastModelSelection.provider,
            { model: this.lastModelSelection.model.modelId },
          );
          const llmResult = await adapter.generateText(prompt, {
            model: this.lastModelSelection.model.modelId,
            temperature: 0.0,
            maxTokens: 2048,
            metadata: {
              trajectoryId: trajectory.trajectoryId,
              analysisType: 'trajectory_intelligence',
              routedProvider: this.lastModelSelection.provider,
              routedModel: this.lastModelSelection.model.modelId,
            },
          });
          const mergedResult = this.mergeLlmAnalysis(
            heuristicResult,
            this.parseLlmTrajectoryAnalysis(llmResult.text),
          );
          const entropyAnalysis = this.recordEntropyAnalysis(trajectory, mergedResult);

          return { ...mergedResult, normalizedVariance: entropyAnalysis.normalizedVariance };
        } catch (error) {
          this.logger?.warn('LLM trajectory extraction failed, falling back to heuristic', {
            trajectoryId: trajectory.trajectoryId,
            provider: this.lastModelSelection.provider,
            modelId: this.lastModelSelection.model.modelId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const entropyAnalysis = this.recordEntropyAnalysis(trajectory, heuristicResult);

      return { ...heuristicResult, normalizedVariance: entropyAnalysis.normalizedVariance };
    }

    // No router available: pure heuristic path
    const result = this.heuristicFallback.extractIntelligence(trajectory, config);
    const entropyAnalysis = this.recordEntropyAnalysis(trajectory, result);

    return { ...result, normalizedVariance: entropyAnalysis.normalizedVariance };
  }

  /** Build the complete prompt set for a trajectory (for prompt inspection/testing). */
  buildPrompts(trajectory: AgentTrajectory): {
    readonly reasoningTypePrompts: readonly string[];
    readonly cognitivePatternPrompt: string;
    readonly outcomePrompt: string;
    readonly subtaskPrompt: string;
  } {
    return {
      reasoningTypePrompts: trajectory.steps.map(s => PROMPTS.reasoningType(s)),
      cognitivePatternPrompt: PROMPTS.cognitivePattern(trajectory.steps),
      outcomePrompt: PROMPTS.outcomeAssessment(
        trajectory.taskDescription, trajectory.steps.length, trajectory.taskCompleted,
      ),
      subtaskPrompt: PROMPTS.subtaskSegmentation(trajectory.steps),
    };
  }

  private buildLlmExtractionPrompt(trajectory: AgentTrajectory): string {
    const prompts = this.buildPrompts(trajectory);
    return [
      'You analyze agent execution trajectories and must return JSON only.',
      'Infer improved trajectory intelligence for the supplied steps.',
      '',
      'Allowed enums:',
      `- outcomeClassification: ${OUTCOME_CLASSIFICATIONS.join(' | ')}`,
      `- reasoningTypes[*]: ${REASONING_TYPES.join(' | ')}`,
      `- detectedPatterns[*].pattern: ${COGNITIVE_PATTERNS.join(' | ')}`,
      `- subtasks[*].outcome: ${OUTCOME_CLASSIFICATIONS.join(' | ')}`,
      '',
      'Return this shape exactly:',
      '{',
      '  "outcomeClassification": "clean_success",',
      '  "reasoningTypes": ["planning"],',
      '  "detectedPatterns": [{ "pattern": "hypothesis_testing", "evidenceSteps": [0,1], "confidence": 0.8 }],',
      '  "subtasks": [{ "goal": "diagnose imports", "startStep": 0, "endStep": 2, "outcome": "clean_success" }],',
      '  "efficiencyScore": 0.75,',
      '  "recoveryDetected": false',
      '}',
      '',
      `Task: ${trajectory.taskDescription}`,
      `Completed: ${trajectory.taskCompleted}`,
      `Steps: ${trajectory.steps.length}`,
      '',
      'Reasoning-type prompts:',
      ...prompts.reasoningTypePrompts,
      '',
      prompts.cognitivePatternPrompt,
      '',
      prompts.outcomePrompt,
      '',
      prompts.subtaskPrompt,
    ].join('\n');
  }

  extractBatch(
    trajectories: readonly AgentTrajectory[],
    config: TrajectoryExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  ): readonly TrajectoryIntelligenceResult[] {
    return trajectories.map(t => this.extractIntelligence(t, config));
  }

  getStats(): ExtractionStats {
    return { ...this.heuristicFallback.getStats() };
  }

  whenReady(): Promise<void> {
    return this.heuristicFallback.whenReady?.() ?? Promise.resolve();
  }

  /**
   * Get the entropy analysis from the last extraction.
   * Returns undefined if no extraction has been performed.
   */
  getLastEntropyAnalysis(): EntropyAnalysis | undefined {
    return this.lastEntropyAnalysis;
  }

  /**
   * Get the model selection from the last LLM-routed extraction.
   * Returns undefined if no LLM-routed extraction has been performed.
   */
  getLastModelSelection(): ModelSelection | undefined {
    return this.lastModelSelection;
  }

  /** Number of times PROBE was triggered due to high entropy. */
  get probeCount(): number {
    return this.probeTriggeredCount;
  }

  watchProbeTriggers(listener: ProbeTriggerListener): () => void {
    this.probeListeners.add(listener);
    return () => {
      this.probeListeners.delete(listener);
    };
  }

  /**
   * Analyze extraction entropy to detect uncertain/ambiguous trajectories.
   *
   * Computes Shannon entropy from the reasoning type distribution of extracted steps.
   * High entropy (uniform distribution across types) suggests the extraction was
   * uncertain about step classification — triggering PROBE for clarification.
   *
   * Step length variance serves as a proxy for logprob variance (arXiv:2601.15690):
   * high variance in step lengths correlates with inconsistent reasoning quality.
   *
   * @see arXiv:2601.15690 — Uncertainty as Metacognitive Control
   * @see arXiv:2510.19771 — PROBE (proactive bottleneck resolution)
   */
  private analyzeEntropy(
    trajectory: AgentTrajectory,
    result: TrajectoryIntelligenceResult,
  ): EntropyAnalysis {
    const PROBE_THRESHOLD = 0.7;

    // Count reasoning type distribution
    const typeCounts = new Map<string, number>();
    for (const step of result.reasoningSteps) {
      typeCounts.set(step.reasoningType, (typeCounts.get(step.reasoningType) ?? 0) + 1);
    }

    // Shannon entropy (normalized to [0, 1])
    const total = result.reasoningSteps.length;
    let entropy = 0;
    if (total > 0) {
      const maxEntropy = Math.log2(Math.max(typeCounts.size, 1));
      for (const count of typeCounts.values()) {
        const p = count / total;
        if (p > 0) entropy -= p * Math.log2(p);
      }
      entropy = maxEntropy > 0 ? entropy / maxEntropy : 0;
    }

    // Step length variance (proxy for logprob variance)
    const lengths = trajectory.steps.map(s => s.length);
    const meanLen = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
    const stepLengthVariance = lengths.length > 0
      ? lengths.reduce((sum, l) => sum + (l - meanLen) ** 2, 0) / lengths.length
      : 0;
    // Normalize variance to [0, 1] range (cap at 10000 chars² variance)
    const normalizedVariance = Math.min(1.0, stepLengthVariance / 10000);

    // Combined uncertainty signal
    const combinedUncertainty = entropy * 0.6 + normalizedVariance * 0.4;
    const probeTriggered = combinedUncertainty > PROBE_THRESHOLD;

    const clarificationRequest = probeTriggered
      ? `[PROBE] High extraction uncertainty detected (entropy=${entropy.toFixed(2)}, ` +
        `variance=${normalizedVariance.toFixed(2)}). Task "${trajectory.taskDescription}" ` +
        `may benefit from clarification: What was the intended approach strategy?`
      : undefined;

    return { entropy, probeTriggered, clarificationRequest, stepLengthVariance, normalizedVariance };
  }

  private recordEntropyAnalysis(
    trajectory: AgentTrajectory,
    result: TrajectoryIntelligenceResult,
  ): EntropyAnalysis {
    const entropyAnalysis = this.analyzeEntropy(trajectory, result);
    this.lastEntropyAnalysis = entropyAnalysis;
    if (!entropyAnalysis.probeTriggered) {
      return entropyAnalysis;
    }

    this.probeTriggeredCount++;
    this.notifyProbeListeners({
      trajectoryId: trajectory.trajectoryId,
      taskDescription: trajectory.taskDescription,
      analysis: {
        ...entropyAnalysis,
        probeTriggered: true,
        clarificationRequest: entropyAnalysis.clarificationRequest ?? '[PROBE] Clarification requested.',
      },
    });
    this.logger?.warn('[PROBE] High extraction uncertainty detected', {
      trajectoryId: trajectory.trajectoryId,
      taskDescription: trajectory.taskDescription,
      entropy: entropyAnalysis.entropy,
      normalizedVariance: entropyAnalysis.normalizedVariance,
      clarificationRequest: entropyAnalysis.clarificationRequest ?? '[PROBE] Clarification requested.',
    });

    return entropyAnalysis;
  }

  private notifyProbeListeners(notification: ProbeTriggerNotification): void {
    for (const listener of this.probeListeners) {
      try {
        const maybePromise = listener(notification);
        if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === 'function') {
          void maybePromise.catch(() => undefined);
        }
      } catch {
        // Listener notifications are best-effort and must not break extraction.
      }
    }
  }

  private parseLlmTrajectoryAnalysis(text: string): ParsedLlmTrajectoryAnalysis {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM trajectory extraction did not return JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    const reasoningTypes = Array.isArray(parsed.reasoningTypes)
      ? parsed.reasoningTypes.filter((value): value is ReasoningType => this.isReasoningType(value))
      : undefined;

    const detectedPatterns = Array.isArray(parsed.detectedPatterns)
      ? parsed.detectedPatterns
          .map((value, index) => this.parseDetectedPattern(value, index))
          .filter((value): value is DetectedPattern => value !== undefined)
      : undefined;

    const subtasks = Array.isArray(parsed.subtasks)
      ? parsed.subtasks
          .map((value, index) => this.parseSubtask(value, index))
          .filter((value): value is TrajectorySubtask => value !== undefined)
      : undefined;

    return {
      outcomeClassification: this.isOutcomeClassification(parsed.outcomeClassification)
        ? parsed.outcomeClassification
        : undefined,
      reasoningTypes,
      detectedPatterns,
      subtasks,
      efficiencyScore: this.parseScore(parsed.efficiencyScore),
      recoveryDetected: typeof parsed.recoveryDetected === 'boolean'
        ? parsed.recoveryDetected
        : undefined,
    };
  }

  private mergeLlmAnalysis(
    heuristicResult: TrajectoryIntelligenceResult,
    llmAnalysis: ParsedLlmTrajectoryAnalysis,
  ): TrajectoryIntelligenceResult {
    const reasoningSteps = llmAnalysis.reasoningTypes?.length === heuristicResult.reasoningSteps.length
      ? heuristicResult.reasoningSteps.map((step, index) => ({
          ...step,
          reasoningType: llmAnalysis.reasoningTypes?.[index] ?? step.reasoningType,
        }))
      : heuristicResult.reasoningSteps;

    return {
      ...heuristicResult,
      outcomeClassification: llmAnalysis.outcomeClassification ?? heuristicResult.outcomeClassification,
      reasoningSteps,
      detectedPatterns: llmAnalysis.detectedPatterns?.length
        ? llmAnalysis.detectedPatterns
        : heuristicResult.detectedPatterns,
      subtasks: llmAnalysis.subtasks?.length ? llmAnalysis.subtasks : heuristicResult.subtasks,
      efficiencyScore: llmAnalysis.efficiencyScore ?? heuristicResult.efficiencyScore,
      recoveryDetected: llmAnalysis.recoveryDetected ?? heuristicResult.recoveryDetected,
    };
  }

  private parseDetectedPattern(value: unknown, index: number): DetectedPattern | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (!this.isCognitivePattern(record.pattern)) {
      return undefined;
    }

    const evidenceSteps = Array.isArray(record.evidenceSteps)
      ? record.evidenceSteps
          .filter((step): step is number => typeof step === 'number' && Number.isInteger(step) && step >= 0)
      : [];

    return {
      pattern: record.pattern,
      evidenceSteps,
      confidence: this.parseScore(record.confidence) ?? (index >= 0 ? 0.5 : 0.5),
    };
  }

  private parseSubtask(value: unknown, index: number): TrajectorySubtask | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.goal !== 'string' || !this.isOutcomeClassification(record.outcome)) {
      return undefined;
    }

    const startStep = typeof record.startStep === 'number' && Number.isInteger(record.startStep)
      ? record.startStep
      : undefined;
    const endStep = typeof record.endStep === 'number' && Number.isInteger(record.endStep)
      ? record.endStep
      : undefined;
    if (startStep === undefined || endStep === undefined) {
      return undefined;
    }

    return {
      subtaskId: `llm-subtask-${index + 1}`,
      goal: record.goal,
      startStep,
      endStep,
      outcome: record.outcome,
    };
  }

  private parseScore(value: unknown): number | undefined {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return undefined;
    }
    return Math.max(0, Math.min(1, value));
  }

  private isReasoningType(value: unknown): value is ReasoningType {
    return typeof value === 'string' && REASONING_TYPES.includes(value as ReasoningType);
  }

  private isCognitivePattern(value: unknown): value is CognitivePattern {
    return typeof value === 'string' && COGNITIVE_PATTERNS.includes(value as CognitivePattern);
  }

  private isOutcomeClassification(value: unknown): value is TrajectoryOutcomeClassification {
    return typeof value === 'string' && OUTCOME_CLASSIFICATIONS.includes(value as TrajectoryOutcomeClassification);
  }

  reset(): void {
    this.heuristicFallback.reset();
    this.extractionCount = 0;
    this.llmEnhancedCount = 0;
    this.probeTriggeredCount = 0;
    this.probeListeners.clear();
    this.lastEntropyAnalysis = undefined;
    this.lastModelSelection = undefined;
  }
}
