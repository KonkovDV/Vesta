/**
 * BayesianWeightManager — Judge accuracy weight tracking
 *
 * Maintains per-judge accuracy weights updated via Bayesian rule
 * with exponential decay for recency bias.
 *
 * @layer Infrastructure
 * @pattern Pillar-3 Bayesian Weight Tracking
 * @see 03_LATS_BAYESIAN_CONSENSUS.md §3.3
 */

import type { JudgeVote } from '../../../domain/evaluation/IMultiJudgeEvaluator';

export class BayesianWeightManager {
  private readonly weights: Map<string, number> = new Map();
  private readonly priorAccuracy: number;
  private readonly decay: number;

  constructor(priorAccuracy: number, weightDecay: number) {
    this.priorAccuracy = Math.max(0.01, Math.min(0.99, priorAccuracy));
    this.decay = Math.max(0, Math.min(1, weightDecay));
  }

  /**
   * Bayesian update of judge accuracy weight.
   * w_new = decay * w_old + (1 - decay) * outcome
   * Clamped to [0.01, 0.99] to avoid numerical issues in log-odds.
   */
  update(judgeId: string, wasCorrect: boolean): void {
    const current = this.weights.get(judgeId) ?? this.priorAccuracy;
    const outcome = wasCorrect ? 1.0 : 0.0;
    const newWeight = this.decay * current + (1 - this.decay) * outcome;
    this.weights.set(judgeId, Math.max(0.01, Math.min(0.99, newWeight)));
  }

  /**
   * Compute Bayesian posterior: P(correct | votes).
   * Uses log-odds formulation for numerical stability.
   *
   * σ(Σ log(w_i/(1-w_i)) for approve, log((1-w_i)/w_i) for reject)
   */
  computeConsensus(votes: readonly JudgeVote[]): number {
    let logOdds = 0;

    for (const vote of votes) {
      if (vote.vote === 'abstain') continue;
      const w = this.weights.get(vote.judgeId) ?? this.priorAccuracy;

      if (vote.vote === 'approve') {
        logOdds += Math.log(w / (1 - w));
      } else {
        logOdds += Math.log((1 - w) / w);
      }
    }

    return 1 / (1 + Math.exp(-logOdds));
  }

  getWeight(judgeId: string): number {
    return this.weights.get(judgeId) ?? this.priorAccuracy;
  }

  getAllWeights(): Map<string, number> {
    return new Map(this.weights);
  }
}
