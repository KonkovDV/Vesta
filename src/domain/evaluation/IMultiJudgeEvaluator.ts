/**
 * IMultiJudgeEvaluator — Bayesian Multi-Judge Consensus Domain Port
 *
 * Extends CC-002 (IMultiModelConsensus) with Bayesian weight tracking
 * and structured judge voting for LATS node evaluation.
 *
 * @layer Domain
 * @pattern Pillar-3 Bayesian Consensus
 * @see Zheng et al. "Judging LLM-as-a-Judge" (NeurIPS 2023, arXiv:2306.05685)
 * @see src/domain/evaluation/IMultiModelConsensus.ts — CC-002 base
 * @FITNESS-K 93.0
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ────────────────────────────────────────────────────────────────────

export type JudgeDecision = 'approve' | 'reject' | 'abstain';

export interface JudgeVote {
  readonly judgeId: string;
  readonly modelId: string;
  readonly vote: JudgeDecision;
  readonly confidence: number;
  readonly rationale: string;
  readonly historicalAccuracy: number;
}

export interface ConsensusResult {
  readonly decision: 'approved' | 'rejected' | 'inconclusive';
  readonly consensusProbability: number;
  readonly votes: readonly JudgeVote[];
  readonly quorumMet: boolean;
  readonly dissenting: readonly JudgeVote[];
}

export interface ConsensusConfig {
  readonly minJudges: number;
  readonly approvalThreshold: number;
  readonly priorAccuracy: number;
  readonly weightDecay: number;
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface IMultiJudgeEvaluator {
  /**
   * Submit a prompt/response to N judges and compute Bayesian consensus.
   */
  evaluate(
    prompt: string,
    response: string,
    config: ConsensusConfig,
    correlationId: CorrelationId,
  ): Promise<ConsensusResult>;

  /**
   * Update judge accuracy weights based on ground-truth feedback.
   */
  updateJudgeAccuracy(
    judgeId: string,
    wasCorrect: boolean,
  ): Promise<void>;

  /**
   * Get current accuracy weights for all registered judges.
   */
  getJudgeWeights(): Promise<Map<string, number>>;
}
