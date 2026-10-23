/**
 * MultiJudgeEvalAdapter — IMultiJudgeEvaluator infrastructure implementation
 *
 * Orchestrates N-judge evaluation with Bayesian weight tracking and
 * dynamic Mixture-of-Experts (MoE) routing for judge selection.
 *
 * SOTA 2026: Instead of sequential slice of judges, the adapter classifies
 * the task domain (architecture/security/typing/DI/testing) and routes to
 * judges whose specializations match, weighted by historical accuracy.
 *
 * @layer Infrastructure
 * @pattern Pillar-3 Bayesian Multi-Judge Consensus + MoE Routing
 * @see 03_LATS_BAYESIAN_CONSENSUS.md §3.3
 * @see Jiang et al. (2024) "Mixtral of Experts" arXiv:2401.04088
 */

import type {
  IMultiJudgeEvaluator,
  JudgeVote,
  ConsensusResult,
  ConsensusConfig,
  JudgeDecision,
} from '../../../domain/evaluation/IMultiJudgeEvaluator';
import type { CorrelationId } from '../../../core/types/branded';
import type { IEvaluationMemory } from '../../../domain/memory/IEvaluationMemory';
import { BayesianWeightManager } from './BayesianWeightManager';

/** Minimal logger interface for optional structured logging. */
interface MinimalLogger {
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Judge provider definition — represents one LLM judge.
 */
export interface JudgeProvider {
  readonly judgeId: string;
  readonly modelId: string;
  /** Optional domain specializations for MoE routing. */
  readonly specializations?: readonly string[];
  /** Simulated evaluation — real impl should call LLM */
  evaluate(prompt: string, response: string): Promise<{ vote: JudgeDecision; confidence: number; rationale: string }>;
}

/** Configuration for Bayesian weight tracking in multi-judge consensus. */
export interface MultiJudgeEvalConfig {
  readonly priorAccuracy: number;
  readonly weightDecay: number;
  /** When true, throws if evaluation artifacts fail to persist. Defaults to false. */
  readonly durabilityStrictGate?: boolean;
}

type EvaluationMemoryResolver = () => IEvaluationMemory | undefined;

class EvaluationDurabilityGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationDurabilityGateError';
  }
}

export class MultiJudgeEvalAdapter implements IMultiJudgeEvaluator {
  private readonly weightManager: BayesianWeightManager;
  private readonly judges: JudgeProvider[];
  private readonly evalConfig: MultiJudgeEvalConfig;

  constructor(
    judges: JudgeProvider[],
    config: MultiJudgeEvalConfig,
    private readonly logger?: MinimalLogger,
    private readonly resolveEvaluationMemory?: EvaluationMemoryResolver,
  ) {
    this.judges = judges;
    this.evalConfig = config;
    // BayesianWeightManager is an infrastructure-internal utility (not a service),
    // instantiated here per Hard Rule 2 exemption: infra layer may use `new` for
    // internal helpers that have no domain port. See BayesianWeightManager JSDoc.
    this.weightManager = new BayesianWeightManager(config.priorAccuracy, config.weightDecay);
  }

  async evaluate(
    prompt: string,
    response: string,
    config: ConsensusConfig,
    correlationId: CorrelationId,
  ): Promise<ConsensusResult> {
    // MoE routing: classify task domain and select judges by specialization
    const taskDomains = this.classifyTaskDomain(prompt, response);
    const activeJudges = this.routeJudges(taskDomains, config.minJudges);

    // Query all judges in parallel with allSettled for resilience
    const results = await Promise.allSettled(
      activeJudges.map(async (judge): Promise<JudgeVote> => {
        const result = await judge.evaluate(prompt, response);
        return {
          judgeId: judge.judgeId,
          modelId: judge.modelId,
          vote: result.vote,
          confidence: result.confidence,
          rationale: result.rationale,
          historicalAccuracy: this.weightManager.getWeight(judge.judgeId),
        };
      }),
    );

    const votes: JudgeVote[] = [];
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger?.warn?.('Judge evaluation failed', {
          reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
          correlationId,
        });
        continue;
      }
      if (r.status === 'fulfilled') {
        votes.push(r.value);
      }
    }

    // Check quorum
    const nonAbstain = votes.filter(v => v.vote !== 'abstain');
    const quorumMet = nonAbstain.length >= config.minJudges;

    // Compute Bayesian posterior
    const consensusProbability = this.weightManager.computeConsensus(votes);

    // Determine decision
    let decision: ConsensusResult['decision'];
    if (!quorumMet) {
      decision = 'inconclusive';
    } else if (consensusProbability >= config.approvalThreshold) {
      decision = 'approved';
    } else if (consensusProbability <= 1 - config.approvalThreshold) {
      decision = 'rejected';
    } else {
      decision = 'inconclusive';
    }

    // Identify dissenting votes (minority or low confidence)
    const majorityVote = consensusProbability >= 0.5 ? 'approve' : 'reject';
    const dissenting = votes.filter(
      v => v.vote !== 'abstain' && v.vote !== majorityVote,
    );

    this.logger?.info?.('Multi-judge consensus computed', {
      correlationId,
      decision,
      consensusProbability,
      totalVotes: votes.length,
      quorumMet,
    });

    await this.persistEvaluationArtifact({
      prompt,
      response,
      config,
      correlationId,
      taskDomains,
      decision,
      consensusProbability,
      votes,
      quorumMet,
      dissenting,
      activeJudges,
    });

    return { decision, consensusProbability, votes, quorumMet, dissenting };
  }

  async updateJudgeAccuracy(judgeId: string, wasCorrect: boolean): Promise<void> {
    this.weightManager.update(judgeId, wasCorrect);
  }

  async getJudgeWeights(): Promise<Map<string, number>> {
    return this.weightManager.getAllWeights();
  }

  // ─── MoE Routing (SOTA 2026) ──────────────────────────────────

  /** Domain keywords for task classification. */
  private static readonly DOMAIN_KEYWORDS: Record<string, readonly string[]> = {
    architecture: ['layer', 'import', 'dependency', 'clean architecture', 'domain', 'infrastructure', 'inject'],
    security: ['injection', 'xss', 'csrf', 'auth', 'token', 'secret', 'sanitiz', 'owasp', 'vulnerability'],
    typing: ['type', 'interface', 'generic', 'branded', 'schema', 'zod', 'typescript', 'tsc'],
    di: ['di', 'container', 'resolve', 'register', 'singleton', 'DI_TOKENS', 'bootstrap'],
    testing: ['test', 'jest', 'vitest', 'mock', 'expect', 'assert', 'coverage', 'fixture'],
    performance: ['latency', 'throughput', 'cache', 'memory', 'optimize', 'benchmark', 'profil'],
    events: ['event', 'outbox', 'eventstore', 'publish', 'subscribe', 'saga', 'aggregate'],
  };

  /**
   * Classify the task domain by keyword frequency analysis.
   *
   * Scans prompt + response for domain-specific keywords and returns
   * domains sorted by match count (descending). This is a lightweight
   * classifier — replace with embedding-based classifier for higher accuracy.
   */
  classifyTaskDomain(prompt: string, response: string): string[] {
    const combined = `${prompt} ${response}`.toLowerCase();
    const scores: { domain: string; count: number }[] = [];

    for (const [domain, keywords] of Object.entries(MultiJudgeEvalAdapter.DOMAIN_KEYWORDS)) {
      let count = 0;
      for (const kw of keywords) {
        // Count keyword occurrences (word boundary where possible)
        const regex = new RegExp(kw, 'gi');
        const matches = combined.match(regex);
        if (matches) count += matches.length;
      }
      if (count > 0) scores.push({ domain, count });
    }

    return scores
      .sort((a, b) => b.count - a.count)
      .map(s => s.domain);
  }

  /**
   * Route to judges whose specializations match the classified task domains.
   *
   * Strategy (Mixture-of-Experts):
   * 1. If judges have specializations, score each by domain overlap
   * 2. Weight by historical accuracy (Bayesian posterior)
   * 3. Select top-N judges (at least minJudges)
   * 4. Fallback to all judges if no specialization match
   */
  private routeJudges(taskDomains: string[], minJudges: number): JudgeProvider[] {
    // If no judges have specializations, fall back to all judges
    const hasSpecializations = this.judges.some(j => j.specializations && j.specializations.length > 0);
    if (!hasSpecializations || taskDomains.length === 0) {
      return this.judges.slice(0, Math.max(minJudges, this.judges.length));
    }

    // Score each judge by domain overlap × historical accuracy
    const scored = this.judges.map(judge => {
      let domainScore = 0;
      if (judge.specializations) {
        for (const spec of judge.specializations) {
          const domainIdx = taskDomains.indexOf(spec);
          if (domainIdx >= 0) {
            // Higher score for higher-ranked domain match
            domainScore += (taskDomains.length - domainIdx) / taskDomains.length;
          }
        }
      }
      const accuracy = this.weightManager.getWeight(judge.judgeId);
      const compositeScore = domainScore * 0.6 + accuracy * 0.4;
      return { judge, compositeScore, domainScore };
    });

    // Sort by composite score descending
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    // Select at least minJudges, preferring specialized ones
    const selected = scored.slice(0, Math.max(minJudges, scored.filter(s => s.domainScore > 0).length));
    if (selected.length < minJudges) {
      // Fill remaining slots from unselected judges
      const selectedIds = new Set(selected.map(s => s.judge.judgeId));
      const remaining = scored.filter(s => !selectedIds.has(s.judge.judgeId));
      selected.push(...remaining.slice(0, minJudges - selected.length));
    }

    this.logger?.info?.('MoE judge routing', {
      taskDomains: taskDomains.slice(0, 3),
      selectedJudges: selected.map(s => s.judge.judgeId),
      scores: selected.map(s => ({ id: s.judge.judgeId, score: s.compositeScore.toFixed(3) })),
    });

    return selected.map(s => s.judge);
  }

  private async persistEvaluationArtifact(input: {
    prompt: string;
    response: string;
    config: ConsensusConfig;
    correlationId: CorrelationId;
    taskDomains: string[];
    decision: ConsensusResult['decision'];
    consensusProbability: number;
    votes: JudgeVote[];
    quorumMet: boolean;
    dissenting: JudgeVote[];
    activeJudges: JudgeProvider[];
  }): Promise<void> {
    const evaluationMemory = this.resolveEvaluationMemory?.();
    if (!evaluationMemory) {
      return;
    }

    const verdict = input.decision === 'approved'
      ? 'pass'
      : input.decision === 'rejected'
        ? 'fail'
        : 'inconclusive';
    const timestamp = new Date().toISOString();

    try {
      const persisted = await evaluationMemory.recordRun({
        correlationId: input.correlationId,
        run: {
          runId: `multi-judge-${input.correlationId}-${Date.now()}`,
          plane: 'evaluation',
          benchmarkId: 'multi-judge-consensus',
          benchmarkVersion: 'v1',
          summary: `Multi-judge consensus ${input.decision} with ${input.votes.length} vote(s) and ${input.dissenting.length} dissenting`,
          verdict,
          timestamp,
          score: input.consensusProbability,
          maxScore: 1,
          model: input.activeJudges.map((judge) => judge.modelId).join(','),
          config: {
            minJudges: input.config.minJudges,
            approvalThreshold: input.config.approvalThreshold,
            priorAccuracy: input.config.priorAccuracy,
            weightDecay: input.config.weightDecay,
            taskDomains: input.taskDomains,
            promptLength: input.prompt.length,
            responseLength: input.response.length,
          },
          judges: input.votes,
          aggregate: {
            decision: input.decision,
            consensusProbability: input.consensusProbability,
            quorumMet: input.quorumMet,
            dissentingCount: input.dissenting.length,
          },
          metadata: {
            judgeIds: input.activeJudges.map((judge) => judge.judgeId),
          },
        },
      });

      if (!persisted.stored) {
        if (this.evalConfig.durabilityStrictGate) {
          throw new EvaluationDurabilityGateError(
            `Evaluation artifact was not durably stored for benchmark multi-judge-consensus (${persisted.storedRunId})`,
          );
        }

        this.logger?.warn?.('Evaluation artifact was accepted but not durably stored', {
          correlationId: input.correlationId,
          storedRunId: persisted.storedRunId,
          benchmarkId: 'multi-judge-consensus',
        });
      }
    } catch (error) {
      if (error instanceof EvaluationDurabilityGateError) {
        throw error;
      }

      if (this.evalConfig.durabilityStrictGate) {
        throw new EvaluationDurabilityGateError(
          `Failed to persist evaluation artifact: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      this.logger?.warn?.('Failed to persist evaluation artifact', {
        correlationId: input.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
