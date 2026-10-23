/**
 * VotingAggregatorAdapter — Infrastructure adapter for IVotingAggregator.
 *
 * Implements three voting modes:
 * - majority: simple majority wins (most common vote)
 * - weighted: votes weighted by per-voter weights or reputation
 * - unanimous: requires all votes to agree; falls back to majority if not
 *
 * Pure computation — no I/O, no LLM calls.
 *
 * Best Practices Applied (March 2026):
 * - correlationId in all log entries (Hard Rule #6)
 * - Generic type parameter T for flexible vote types
 *
 * DI: constructor(logger) — 1 arg
 *
 * @layer Infrastructure (implements Domain port)
 * @see IVotingAggregator (src/domain/evaluation/voting-aggregator.interface.ts)
 * @see Book Ch.3 "Parallelization" — Voting subpattern
 */

import type {
  IVotingAggregator,
  VoteEntry,
  VotingConfig,
  VotingResult,
} from '../../domain/evaluation/voting-aggregator.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

export class VotingAggregatorAdapter implements IVotingAggregator {
  constructor(
    private readonly logger: ILogger,
  ) {}

  aggregate<T = string>(
    votes: readonly VoteEntry<T>[],
    config: VotingConfig,
    correlationId: CorrelationId,
  ): VotingResult<T> {
    if (votes.length === 0) {
      throw new Error('Cannot aggregate empty votes');
    }

    const tally = new Map<string, number>();

    for (const entry of votes) {
      const voteKey = String(entry.vote);
      const weight = this.getWeight(entry, config);
      tally.set(voteKey, (tally.get(voteKey) ?? 0) + weight);
    }

    // Convert to Record
    const tallyRecord: Record<string, number> = {};
    for (const [key, value] of tally) {
      tallyRecord[key] = value;
    }

    // Determine winner
    let winnerKey = '';
    let maxScore = -Infinity;
    for (const [key, score] of tally) {
      if (score > maxScore) {
        maxScore = score;
        winnerKey = key;
      }
    }

    // Find the actual vote value for the winner key
    const winnerVote = votes.find((v) => String(v.vote) === winnerKey)!.vote;

    // Check unanimity
    const uniqueVotes = new Set(votes.map((v) => String(v.vote)));
    const unanimous = uniqueVotes.size === 1;

    // For unanimous mode, if not unanimous, log a warning
    if (config.mode === 'unanimous' && !unanimous) {
      this.logger.warn('Unanimous vote not achieved, falling back to majority', {
        correlationId,
        uniqueVotes: uniqueVotes.size,
        totalVoters: votes.length,
      });
    }

    this.logger.debug('Vote aggregation completed', {
      correlationId,
      mode: config.mode,
      totalVoters: votes.length,
      winner: winnerKey,
      unanimous,
    });

    return {
      winner: winnerVote,
      tally: tallyRecord,
      unanimous,
      totalVoters: votes.length,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private getWeight<T>(entry: VoteEntry<T>, config: VotingConfig): number {
    if (config.mode !== 'weighted') return 1;

    // Check reputation weights first (H5 Liquid Democracy)
    if (config.reputationWeights?.[entry.voterId] !== undefined) {
      return config.reputationWeights[entry.voterId];
    }

    // Then per-voter weights
    if (config.weights?.[entry.voterId] !== undefined) {
      return config.weights[entry.voterId];
    }

    // Default weight
    return 1;
  }
}
