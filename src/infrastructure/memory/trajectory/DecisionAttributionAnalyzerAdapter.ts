/**
 * DecisionAttributionAnalyzerAdapter — In-memory causal chain attribution of agent decisions.
 *
 * Builds structured causal chains (immediate → proximate → root cause) from trajectory
 * intelligence. Uses heuristic analysis of reasoning step patterns to attribute decisions
 * to failure, recovery, inefficiency, or success outcomes.
 *
 * @layer Infrastructure (Memory)
 * @pattern CC-034 Decision Attribution Analyzer (TIM arXiv:2603.10600)
 * @see src/domain/memory/IDecisionAttributionAnalyzer.ts — domain port
 */

import type {
  IDecisionAttributionAnalyzer,
  DecisionAttributionResult,
  DecisionAttribution,
  CausalChain,
  CausalNode,
  AttributionConfig,
  AttributionStats,
  AttributionType,
} from '../../../domain/memory/IDecisionAttributionAnalyzer';
import { DEFAULT_ATTRIBUTION_CONFIG } from '../../../domain/memory/IDecisionAttributionAnalyzer';
import type {
  TrajectoryIntelligenceResult,
  ReasoningStep,
} from '../../../domain/memory/ITrajectoryIntelligenceExtractor';

// ── Adapter ───────────────────────────────────────────────────────

export class DecisionAttributionAnalyzerAdapter implements IDecisionAttributionAnalyzer {
  private readonly results: DecisionAttributionResult[] = [];
  private idCounter = 0;

  analyzeDecisions(
    intelligence: TrajectoryIntelligenceResult,
    config: AttributionConfig = DEFAULT_ATTRIBUTION_CONFIG,
  ): DecisionAttributionResult {
    const attributions: DecisionAttribution[] = [];

    // Attribute based on outcome classification
    switch (intelligence.outcomeClassification) {
      case 'failure':
        attributions.push(
          ...this.buildFailureAttributions(intelligence, config),
        );
        break;
      case 'recovery':
        attributions.push(
          ...this.buildRecoveryAttributions(intelligence, config),
        );
        break;
      case 'inefficient_success':
        attributions.push(
          ...this.buildInefficiencyAttributions(intelligence, config),
        );
        break;
      case 'clean_success':
        attributions.push(
          ...this.buildSuccessAttributions(intelligence, config),
        );
        break;
    }

    const filtered = attributions
      .filter(a => a.causalChain.chainConfidence >= config.minAttributionConfidence)
      .slice(0, config.maxAttributions);

    const primaryRootCause = filtered.length > 0
      ? filtered.reduce((best, a) => a.impactScore > best.impactScore ? a : best)
          .causalChain.rootCause.description
      : undefined;

    const result: DecisionAttributionResult = {
      trajectoryId: intelligence.trajectoryId,
      outcomeClassification: intelligence.outcomeClassification,
      attributions: filtered,
      primaryRootCause,
      recoveryAttributed: filtered.some(a => a.attributionType === 'recovery'),
      analyzedAt: new Date().toISOString(),
    };

    this.results.push(result);
    return result;
  }

  analyzeBatch(
    intelligences: readonly TrajectoryIntelligenceResult[],
    config: AttributionConfig = DEFAULT_ATTRIBUTION_CONFIG,
  ): readonly DecisionAttributionResult[] {
    return intelligences.map(i => this.analyzeDecisions(i, config));
  }

  getStats(): AttributionStats {
    const dist: Record<AttributionType, number> = {
      failure: 0,
      recovery: 0,
      inefficiency: 0,
      success: 0,
    };

    let totalAttr = 0;
    const rootCauseCounts = new Map<string, number>();

    for (const r of this.results) {
      for (const a of r.attributions) {
        dist[a.attributionType]++;
        totalAttr++;
        const rc = a.causalChain.rootCause.description;
        rootCauseCounts.set(rc, (rootCauseCounts.get(rc) ?? 0) + 1);
      }
    }

    const topRootCauses = [...rootCauseCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([rc]) => rc);

    return {
      trajectoriesAnalyzed: this.results.length,
      typeDistribution: dist,
      avgAttributionsPerTrajectory: this.results.length > 0
        ? totalAttr / this.results.length
        : 0,
      topRootCauses,
    };
  }

  reset(): void {
    this.results.length = 0;
    this.idCounter = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private buildFailureAttributions(
    intel: TrajectoryIntelligenceResult,
    config: AttributionConfig,
  ): DecisionAttribution[] {
    const steps = intel.reasoningSteps;
    if (steps.length === 0) return [];

    // Find the last meaningful step as the failure point
    const failureStep = steps[steps.length - 1];
    const noInfoSteps = steps.filter(s => !s.producedNewInfo);

    const immediate = this.makeNode('immediate',
      `Task failed at step ${failureStep.stepIndex}: ${failureStep.description.slice(0, 80)}`,
      [failureStep.stepIndex], 0.8);

    const proximate = noInfoSteps.length > steps.length * 0.3
      ? this.makeNode('proximate', 'Repeated approaches without new information', noInfoSteps.map(s => s.stepIndex).slice(0, 5), 0.7)
      : this.makeNode('proximate', 'Insufficient problem decomposition', steps.slice(0, 3).map(s => s.stepIndex), 0.5);

    const rootCause = this.inferRootCause(steps, intel);

    const chain = this.makeChain(immediate, proximate, rootCause);
    const attribution: DecisionAttribution = {
      attributionId: `attr-${this.idCounter++}`,
      attributionType: 'failure',
      causalChain: chain,
      impactScore: 0.9,
      decisionStep: failureStep.stepIndex,
      alternativeAction: config.suggestAlternatives
        ? 'Consider switching to a fundamentally different approach after 2 consecutive failures'
        : undefined,
    };

    return [attribution];
  }

  private buildRecoveryAttributions(
    intel: TrajectoryIntelligenceResult,
    config: AttributionConfig,
  ): DecisionAttribution[] {
    const steps = intel.reasoningSteps;
    const reflectionSteps = steps.filter(s => s.reasoningType === 'reflection');
    const validationSteps = steps.filter(s => s.reasoningType === 'validation' && s.producedNewInfo);

    if (reflectionSteps.length === 0) return [];

    const pivotStep = reflectionSteps[0];
    const immediate = this.makeNode('immediate',
      `Recovery pivot at step ${pivotStep.stepIndex}: ${pivotStep.description.slice(0, 80)}`,
      [pivotStep.stepIndex], 0.8);

    const proximate = this.makeNode('proximate',
      'Agent recognized failing approach and switched strategy',
      reflectionSteps.map(s => s.stepIndex), 0.7);

    const rootCause = this.makeNode('root_cause',
      'Initial approach was misaligned with problem structure',
      steps.slice(0, Math.min(3, steps.length)).map(s => s.stepIndex), 0.6);

    const chain = this.makeChain(immediate, proximate, rootCause);

    const attributions: DecisionAttribution[] = [{
      attributionId: `attr-${this.idCounter++}`,
      attributionType: 'recovery',
      causalChain: chain,
      impactScore: 0.7,
      decisionStep: pivotStep.stepIndex,
      alternativeAction: config.suggestAlternatives
        ? 'Could have started with more thorough problem analysis to avoid the recovery pivot'
        : undefined,
    }];

    // Also attribute success after recovery
    if (validationSteps.length > 0) {
      const successStep = validationSteps[validationSteps.length - 1];
      attributions.push({
        attributionId: `attr-${this.idCounter++}`,
        attributionType: 'success',
        causalChain: this.makeChain(
          this.makeNode('immediate', `Validation succeeded at step ${successStep.stepIndex}`, [successStep.stepIndex], 0.9),
          this.makeNode('proximate', 'Recovery led to correct approach', reflectionSteps.map(s => s.stepIndex), 0.7),
          this.makeNode('root_cause', 'Adaptive strategy switching', [pivotStep.stepIndex], 0.6),
        ),
        impactScore: 0.6,
        decisionStep: successStep.stepIndex,
      });
    }

    return attributions;
  }

  private buildInefficiencyAttributions(
    intel: TrajectoryIntelligenceResult,
    config: AttributionConfig,
  ): DecisionAttribution[] {
    const steps = intel.reasoningSteps;
    const wastedSteps = steps.filter(s => !s.producedNewInfo);

    if (wastedSteps.length === 0) return [];

    const immediate = this.makeNode('immediate',
      `${wastedSteps.length} of ${steps.length} steps did not produce new information`,
      wastedSteps.map(s => s.stepIndex).slice(0, 5), 0.8);

    const proximate = this.makeNode('proximate',
      'Redundant exploration of already-investigated paths',
      wastedSteps.slice(0, 3).map(s => s.stepIndex), 0.6);

    const rootCause = this.makeNode('root_cause',
      'Missing state tracking or failure to record previously visited hypotheses',
      [steps[0].stepIndex], 0.5);

    return [{
      attributionId: `attr-${this.idCounter++}`,
      attributionType: 'inefficiency',
      causalChain: this.makeChain(immediate, proximate, rootCause),
      impactScore: 1 - intel.efficiencyScore,
      decisionStep: wastedSteps[0].stepIndex,
      alternativeAction: config.suggestAlternatives
        ? 'Maintain an explicit list of tried approaches to avoid redundant exploration'
        : undefined,
    }];
  }

  private buildSuccessAttributions(
    intel: TrajectoryIntelligenceResult,
    _config: AttributionConfig,
  ): DecisionAttribution[] {
    const steps = intel.reasoningSteps;
    if (steps.length === 0) return [];

    const keySteps = steps.filter(s => s.producedNewInfo);
    const planning = steps.filter(s => s.reasoningType === 'planning');

    const immediate = this.makeNode('immediate',
      `Task completed efficiently with ${keySteps.length}/${steps.length} productive steps`,
      keySteps.slice(0, 3).map(s => s.stepIndex), 0.9);

    const proximate = planning.length > 0
      ? this.makeNode('proximate', 'Effective planning before execution', planning.map(s => s.stepIndex), 0.8)
      : this.makeNode('proximate', 'Direct analytical approach', steps.slice(0, 2).map(s => s.stepIndex), 0.6);

    const rootCause = this.makeNode('root_cause',
      'Well-matched strategy to problem structure',
      [steps[0].stepIndex], 0.7);

    return [{
      attributionId: `attr-${this.idCounter++}`,
      attributionType: 'success',
      causalChain: this.makeChain(immediate, proximate, rootCause),
      impactScore: intel.efficiencyScore,
      decisionStep: 0,
    }];
  }

  private inferRootCause(
    steps: readonly ReasoningStep[],
    intel: TrajectoryIntelligenceResult,
  ): CausalNode {
    // Check for trial-and-error pattern
    const trialAndError = intel.detectedPatterns.find(p => p.pattern === 'trial_and_error');
    if (trialAndError) {
      return this.makeNode('root_cause',
        'Over-reliance on trial-and-error without systematic analysis',
        trialAndError.evidenceSteps.slice(0, 3), 0.7);
    }

    // Check for lack of planning
    const planSteps = steps.filter(s => s.reasoningType === 'planning');
    if (planSteps.length === 0) {
      return this.makeNode('root_cause',
        'Missing planning phase before execution',
        [steps[0].stepIndex], 0.6);
    }

    return this.makeNode('root_cause',
      'Misalignment between problem analysis and chosen approach',
      planSteps.map(s => s.stepIndex), 0.5);
  }

  private makeNode(level: CausalNode['level'], description: string, evidenceSteps: number[], confidence: number): CausalNode {
    return { level, description, evidenceSteps, confidence };
  }

  private makeChain(immediate: CausalNode, proximate: CausalNode, rootCause: CausalNode): CausalChain {
    return {
      immediate,
      proximate,
      rootCause,
      chainConfidence: Math.min(immediate.confidence, proximate.confidence, rootCause.confidence),
    };
  }
}
