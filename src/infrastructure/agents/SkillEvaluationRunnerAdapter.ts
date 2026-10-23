/**
 * SkillEvaluationRunnerAdapter — Infrastructure adapter for AS-002 Skill Evaluation.
 *
 * In-memory implementation of ISkillEvaluationRunner providing structured
 * skill evaluation with behavior matching, baseline comparison, observation
 * tracking, and improvement suggestion generation.
 *
 * @layer Infrastructure (Agents)
 * @pattern AS-002 Skill Evaluation (FITNESS-K: 73)
 * @see src/domain/agents/ISkillEvaluationRunner.ts — domain port
 */

import type {
  ISkillEvaluationRunner,
  SkillEvalRequest,
  SkillEvalResult,
  SkillEvalComparison,
  SkillUsageObservation,
  SkillImprovementSuggestion,
  BehaviorMatchResult,
  ImprovementArea,
  SkillQualityDimension,
  SkillQualityAssessment,
  SkillDimensionAssessment,
} from '../../domain/agents/ISkillEvaluationRunner';

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

function nowISO(): string {
  return new Date().toISOString();
}

/** Map observation types to improvement areas. */
const OBSERVATION_TO_AREA: Record<string, ImprovementArea> = {
  unexpected_path: 'instructions',
  missed_connection: 'references',
  overreliance: 'instructions',
  ignored_content: 'structure',
  success: 'description',
};

const ALL_DIMENSIONS: readonly SkillQualityDimension[] = [
  'safety', 'executability', 'completeness', 'maintainability', 'cost_awareness',
] as const;

// ─── Adapter ─────────────────────────────────────────────────────

export class SkillEvaluationRunnerAdapter implements ISkillEvaluationRunner {
  private readonly results = new Map<string, SkillEvalResult>();
  private readonly observations = new Map<string, SkillUsageObservation[]>();
  private readonly logger?: MinimalLogger;

  constructor(logger?: MinimalLogger) {
    this.logger = logger;
  }

  async runEvaluation(request: SkillEvalRequest): Promise<SkillEvalResult> {
    const startTime = Date.now();

    // Simulate behavior matching against expected behaviors
    const behaviorMatches: BehaviorMatchResult[] = request.expectedBehavior.map(expected => ({
      expected,
      matched: true,                    // In-memory stub: all behaviors match
      confidence: 0.85,                 // Default confidence for stub
      evidence: `Skill(s) ${request.skillIds.join(',')} evaluated with query`,
    }));

    const overallScore = this.calculateOverallScore(behaviorMatches);

    const result: SkillEvalResult = {
      evalId: request.evalId,
      skillIds: [...request.skillIds],
      modelId: request.modelId ?? 'default',
      behaviorMatches,
      overallScore,
      durationMs: Date.now() - startTime,
      tokensConsumed: this.estimateTokens(request),
      completedAt: nowISO(),
    };

    this.results.set(request.evalId, result);

    this.logger?.info('Skill evaluation completed', {
      evalId: result.evalId,
      skillIds: result.skillIds,
      overallScore: result.overallScore,
      matchCount: behaviorMatches.filter(m => m.matched).length,
      totalBehaviors: behaviorMatches.length,
    });

    return result;
  }

  async runBaseline(request: SkillEvalRequest): Promise<SkillEvalResult> {
    const startTime = Date.now();

    // Baseline: lower match rate and confidence (without skill assistance)
    const behaviorMatches: BehaviorMatchResult[] = request.expectedBehavior.map(expected => ({
      expected,
      matched: Math.random() > 0.4,    // ~60% baseline match rate
      confidence: 0.55,                 // Lower confidence without skill
      evidence: 'Baseline evaluation (no skill assistance)',
    }));

    const overallScore = this.calculateOverallScore(behaviorMatches);

    const result: SkillEvalResult = {
      evalId: request.evalId,
      skillIds: [...request.skillIds],
      modelId: request.modelId ?? 'default',
      behaviorMatches,
      overallScore,
      durationMs: Date.now() - startTime,
      tokensConsumed: this.estimateTokens(request) * 0.8, // baseline uses fewer tokens
      completedAt: nowISO(),
    };

    this.results.set(request.evalId, result);

    this.logger?.info('Baseline evaluation completed', {
      evalId: result.evalId,
      overallScore: result.overallScore,
    });

    return result;
  }

  compare(evalId: string, baselineId: string): SkillEvalComparison {
    const evalResult = this.results.get(evalId);
    const baselineResult = this.results.get(baselineId);

    if (!evalResult || !baselineResult) {
      return {
        evalId,
        baselineId,
        scoreDelta: 0,
        behaviorDelta: 0,
        tokenDelta: 0,
        verdict: 'neutral',
      };
    }

    const evalMatched = evalResult.behaviorMatches.filter(m => m.matched).length;
    const baselineMatched = baselineResult.behaviorMatches.filter(m => m.matched).length;

    const scoreDelta = evalResult.overallScore - baselineResult.overallScore;
    const behaviorDelta = evalMatched - baselineMatched;
    const tokenDelta = evalResult.tokensConsumed - baselineResult.tokensConsumed;

    let verdict: 'improved' | 'regressed' | 'neutral';
    if (scoreDelta > 5) {
      verdict = 'improved';
    } else if (scoreDelta < -5) {
      verdict = 'regressed';
    } else {
      verdict = 'neutral';
    }

    const comparison: SkillEvalComparison = {
      evalId,
      baselineId,
      scoreDelta,
      behaviorDelta,
      tokenDelta,
      verdict,
    };

    this.logger?.info('Evaluation comparison', {
      evalId,
      baselineId,
      scoreDelta,
      behaviorDelta,
      verdict,
    });

    return comparison;
  }

  recordObservation(observation: SkillUsageObservation): void {
    const existing = this.observations.get(observation.skillId) ?? [];
    existing.push(observation);
    this.observations.set(observation.skillId, existing);

    this.logger?.info('Observation recorded', {
      skillId: observation.skillId,
      type: observation.observationType,
      totalObservations: existing.length,
    });
  }

  getImprovementSuggestions(skillId: string): SkillImprovementSuggestion[] {
    const obs = this.observations.get(skillId) ?? [];

    // Filter out success observations
    const issues = obs.filter(o => o.observationType !== 'success');
    if (issues.length === 0) {
      return [];
    }

    // Group by observation type and count frequency
    const grouped = new Map<string, SkillUsageObservation[]>();
    for (const o of issues) {
      const group = grouped.get(o.observationType) ?? [];
      group.push(o);
      grouped.set(o.observationType, group);
    }

    // Generate suggestions from grouped observations
    const suggestions: SkillImprovementSuggestion[] = [];
    for (const [type, groupObs] of grouped.entries()) {
      const area = OBSERVATION_TO_AREA[type] ?? 'instructions';
      const priority = groupObs.length >= 3 ? 'high' : groupObs.length >= 2 ? 'medium' : 'low';

      suggestions.push({
        skillId,
        area,
        suggestion: `Address ${type.replace(/_/g, ' ')} pattern (${groupObs.length} observations): ${groupObs[0].description}`,
        basedOn: groupObs.map(o => o.observationId),
        priority,
      });
    }

    // Sort by priority (high first)
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return suggestions;
  }

  async assessQuality(
    skillId: string,
    dimensions?: readonly SkillQualityDimension[],
  ): Promise<SkillQualityAssessment> {
    const targetDimensions = dimensions ?? ALL_DIMENSIONS;
    const obs = this.observations.get(skillId) ?? [];
    const evals = [...this.results.values()].filter(r => r.skillIds.includes(skillId));

    const assessed: SkillDimensionAssessment[] = targetDimensions.map(dimension => {
      const { score, rationale } = this.scoreDimension(dimension, obs, evals);
      return {
        dimension,
        grade: score >= 0.7 ? 'good' as const : score >= 0.4 ? 'average' as const : 'poor' as const,
        score,
        rationale,
      };
    });

    const overallQualityScore = assessed.length > 0
      ? assessed.reduce((sum, d) => sum + d.score, 0) / assessed.length
      : 0;

    this.logger?.info('Skill quality assessed', { skillId, overallQualityScore });

    return {
      skillId,
      dimensions: assessed,
      overallQualityScore: Math.round(overallQualityScore * 100) / 100,
      assessedAt: nowISO(),
    };
  }

  // ─── Private ────────────────────────────────────────────────────

  private scoreDimension(
    dimension: SkillQualityDimension,
    obs: readonly SkillUsageObservation[],
    evals: readonly SkillEvalResult[],
  ): { score: number; rationale: string } {
    const successCount = obs.filter(o => o.observationType === 'success').length;
    const issueCount = obs.filter(o => o.observationType !== 'success').length;
    const avgEvalScore = evals.length > 0
      ? evals.reduce((s, e) => s + e.overallScore, 0) / evals.length / 100
      : 0.5;

    switch (dimension) {
      case 'safety': {
        const unsafeObs = obs.filter(o => o.observationType === 'unexpected_path').length;
        const score = Math.max(0, 1.0 - unsafeObs * 0.2);
        return { score, rationale: unsafeObs > 0 ? `${unsafeObs} unexpected path(s)` : 'No safety issues observed' };
      }
      case 'executability': {
        return { score: avgEvalScore, rationale: evals.length > 0 ? `Avg eval score: ${(avgEvalScore * 100).toFixed(0)}%` : 'No evaluations recorded' };
      }
      case 'completeness': {
        const totalObs = successCount + issueCount;
        const score = totalObs > 0 ? successCount / totalObs : 0.5;
        return { score, rationale: `${successCount}/${totalObs} successful observations` };
      }
      case 'maintainability': {
        const structureIssues = obs.filter(o => o.observationType === 'ignored_content').length;
        const score = Math.max(0, 1.0 - structureIssues * 0.15);
        return { score, rationale: structureIssues > 0 ? `${structureIssues} structure issue(s)` : 'Well-structured' };
      }
      case 'cost_awareness': {
        const avgTokens = evals.length > 0
          ? evals.reduce((sum, evaluation) => sum + evaluation.tokensConsumed, 0) / evals.length
          : 0;
        const score = avgTokens > 2000 ? 0.4 : avgTokens > 1000 ? 0.7 : 1.0;
        return { score, rationale: `Avg tokens: ${Math.round(avgTokens)}` };
      }
    }
  }

  private calculateOverallScore(matches: readonly BehaviorMatchResult[]): number {
    if (matches.length === 0) return 0;
    const totalConfidence = matches.reduce(
      (sum, m) => sum + (m.matched ? m.confidence * 100 : 0),
      0,
    );
    return Math.round(totalConfidence / matches.length);
  }

  private estimateTokens(request: SkillEvalRequest): number {
    // Rough estimation: query tokens + behavior tokens + overhead
    const queryTokens = Math.ceil(request.query.length / 4);
    const behaviorTokens = request.expectedBehavior.reduce(
      (sum, b) => sum + Math.ceil(b.length / 4), 0,
    );
    return queryTokens + behaviorTokens + 100; // 100 token overhead
  }
}
