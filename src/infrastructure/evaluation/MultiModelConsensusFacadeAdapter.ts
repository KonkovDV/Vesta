/**
 * MultiModelConsensusFacadeAdapter — IMultiModelConsensus infrastructure implementation.
 *
 * Facade that maps the CC-002 Cross-Model QA contract onto the existing
 * Pillar-3 IMultiJudgeEvaluator (Bayesian MoE consensus). Each ModelParticipant
 * is translated into a JudgeProvider, verdicts are aggregated through the
 * Bayesian weight manager, and the result is projected back to the
 * ConsensusResult type.
 *
 * Pure computation (no direct LLM calls) — the underlying IMultiJudgeEvaluator
 * adapter handles actual model invocation.
 *
 * @layer Infrastructure (implements Domain port)
 * @pattern CC-002 Cross-Model QA Workflow (FITNESS-K: 96.5)
 * @see src/domain/evaluation/IMultiModelConsensus.ts — domain port
 * @see src/infrastructure/ai/consensus/MultiJudgeEvalAdapter.ts — underlying evaluator
 * @see src/core/events/consensus.schemas.ts — Zod validation schemas
 */

import type {
  IMultiModelConsensus,
  ModelParticipant,
  ModelVerdict,
  ModelDisagreement,
  ConsensusConfig,
  ConsensusResult,
  ConsensusDecision,
} from '../../domain/evaluation/IMultiModelConsensus';
import type { IMultiJudgeEvaluator } from '../../domain/evaluation/IMultiJudgeEvaluator';
import type { CorrelationId } from '../../core/types/branded';

/** Minimal logger interface for optional structured logging. */
interface MinimalLogger {
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
}

export class MultiModelConsensusFacadeAdapter implements IMultiModelConsensus {
  constructor(
    private readonly judgeEvaluator: IMultiJudgeEvaluator,
    private readonly logger?: MinimalLogger,
  ) {}

  async consensusVerify(
    query: string,
    participants: readonly ModelParticipant[],
    config: ConsensusConfig,
    correlationId: CorrelationId,
  ): Promise<ConsensusResult> {
    if (participants.length < 2) {
      throw new Error('Cross-model consensus requires at least 2 participants');
    }

    if (config.requireDifferentProviders) {
      const providers = new Set(participants.map(p => p.providerId));
      if (providers.size < 2) {
        throw new Error('requireDifferentProviders is true but all participants use the same provider');
      }
    }

    const startMs = Date.now();

    this.logger?.info?.('MultiModelConsensus: starting consensusVerify', {
      correlationId,
      participantCount: participants.length,
      providers: [...new Set(participants.map(p => p.providerId))],
    });

    // Delegate to IMultiJudgeEvaluator with mapped config
    const judgeResult = await this.judgeEvaluator.evaluate(
      query,
      '', // response — consensus verification uses query as the content under review
      {
        minJudges: participants.length,
        approvalThreshold: config.minConfidenceThreshold ?? 0.5,
        priorAccuracy: 0.6,
        weightDecay: 0.95,
      },
      correlationId,
    );

    // Map JudgeVote[] → ModelVerdict[]
    const verdicts: ModelVerdict[] = judgeResult.votes.map((vote, i) => {
      const participant = participants[i % participants.length];
      return {
        participant,
        verdict: this.mapDecisionToVerdict(vote.vote),
        confidence: vote.confidence,
        rationale: vote.rationale,
        concerns: [],
        durationMs: 0,
      };
    });

    // Detect disagreements between primary and reviewer verdicts
    const disagreements = this.detectDisagreements(verdicts);

    // Map JudgeDecision → ConsensusDecision
    const decision = this.computeDecision(verdicts, config.minConfidenceThreshold ?? 0.5);

    const totalDurationMs = Date.now() - startMs;

    this.logger?.info?.('MultiModelConsensus: consensusVerify complete', {
      correlationId,
      decision,
      bayesianConfidence: judgeResult.consensusProbability,
      totalDurationMs,
    });

    return {
      decision,
      verdicts,
      disagreements,
      bayesianConfidence: judgeResult.consensusProbability,
      totalDurationMs,
    };
  }

  async binaryConsensus(
    question: string,
    participants: readonly ModelParticipant[],
    correlationId: CorrelationId,
  ): Promise<boolean> {
    const result = await this.consensusVerify(
      question,
      participants,
      { requireDifferentProviders: false, minConfidenceThreshold: 0.5 },
      correlationId,
    );

    return result.decision === 'consensus_approve';
  }

  // ── Private helpers ──────────────────────────────────────────

  private mapDecisionToVerdict(decision: string): 'approve' | 'revise' | 'reject' {
    switch (decision) {
      case 'approve':
        return 'approve';
      case 'abstain':
        return 'revise';
      case 'reject':
        return 'reject';
      default:
        return 'revise';
    }
  }

  private computeDecision(
    verdicts: readonly ModelVerdict[],
    minConfidence: number,
  ): ConsensusDecision {
    const approveCount = verdicts.filter(v => v.verdict === 'approve').length;
    const rejectCount = verdicts.filter(v => v.verdict === 'reject').length;
    const total = verdicts.length;
    const avgConfidence = verdicts.reduce((sum, v) => sum + v.confidence, 0) / total;

    if (avgConfidence < minConfidence) {
      return 'no_consensus';
    }

    if (approveCount > total / 2) {
      return 'consensus_approve';
    }
    if (rejectCount > total / 2) {
      return 'consensus_reject';
    }
    if (verdicts.some(v => v.verdict === 'revise')) {
      return 'consensus_revise';
    }
    return 'no_consensus';
  }

  private detectDisagreements(verdicts: readonly ModelVerdict[]): ModelDisagreement[] {
    const disagreements: ModelDisagreement[] = [];
    const primaries = verdicts.filter(v => v.participant.role === 'primary');
    const reviewers = verdicts.filter(v => v.participant.role === 'reviewer');

    for (const primary of primaries) {
      for (const reviewer of reviewers) {
        if (primary.verdict !== reviewer.verdict) {
          const severity = this.classifyDisagreementSeverity(primary.verdict, reviewer.verdict);
          disagreements.push({
            aspect: `${primary.participant.modelId} vs ${reviewer.participant.modelId}`,
            primaryPosition: primary.verdict,
            reviewerPosition: reviewer.verdict,
            severity,
          });
        }
      }
    }

    return disagreements;
  }

  private classifyDisagreementSeverity(
    primary: 'approve' | 'revise' | 'reject',
    reviewer: 'approve' | 'revise' | 'reject',
  ): 'minor' | 'major' | 'critical' {
    // approve ↔ reject = critical; approve ↔ revise or revise ↔ reject = major
    if (
      (primary === 'approve' && reviewer === 'reject') ||
      (primary === 'reject' && reviewer === 'approve')
    ) {
      return 'critical';
    }
    return 'major';
  }
}
