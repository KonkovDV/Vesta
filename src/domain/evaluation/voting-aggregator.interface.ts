/**
 * IVotingAggregator — Domain interface for ensemble/voting patterns.
 *
 * Generalizes voting logic used by IReviewerPanel and other multi-agent
 * ensembles. Supports majority vote, weighted voting, and unanimous modes.
 *
 * Separated from IReviewerPanel to enable reuse across any multi-agent
 * decision-making scenario (reviewer panels, swarm consensus, etc.).
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.3 "Parallelization" — Voting subpattern
 * @see Anthropic Guide — Parallelization "Voting" workflow
 */

import type { CorrelationId } from '@/ai-types';

/**
 * Voting mode.
 */
export type VotingMode = 'majority' | 'weighted' | 'unanimous';

/**
 * Configuration for a voting session.
 */
export interface VotingConfig {
  readonly mode: VotingMode;
  /** Per-voter weights (for 'weighted' mode). */
  readonly weights?: Readonly<Record<string, number>>;
  /** Reviewer reputation weights for H5 Liquid Democracy. */
  readonly reputationWeights?: Readonly<Record<string, number>>;
}

/**
 * A single vote entry.
 */
export interface VoteEntry<T = string> {
  readonly voterId: string;
  readonly vote: T;
  readonly confidence?: number;   // 0-1
}

/**
 * Result of vote aggregation.
 */
export interface VotingResult<T = string> {
  readonly winner: T;
  readonly tally: Readonly<Record<string, number>>;
  readonly unanimous: boolean;
  readonly totalVoters: number;
}

/**
 * Ensemble voting aggregator.
 * Lifecycle: singleton.
 */
export interface IVotingAggregator {
  /** Aggregate votes and determine the winner. */
  aggregate<T = string>(
    votes: readonly VoteEntry<T>[],
    config: VotingConfig,
    correlationId: CorrelationId,
  ): VotingResult<T>;
}
