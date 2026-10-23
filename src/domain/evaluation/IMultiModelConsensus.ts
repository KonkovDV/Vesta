/**
 * IMultiModelConsensus — Domain port for Cross-Model QA Verification.
 *
 * Implements the "Agent Blindness" mitigation pattern: a single LLM cannot reliably
 * detect its own errors. Independent verification by a different model provider
 * is the AI equivalent of code review.
 *
 * @layer Domain (port contract)
 * @pattern CC-002 Cross-Model QA Workflow (FITNESS-K: 96.5)
 * @see claude-code-best-practice: 4-step workflow (Plan→QA Review→Implement→Verify)
 * @see src/domain/evaluation/llm-judge.interface.ts — single-model rubric scoring
 * @see src/domain/evaluation/voting-aggregator.interface.ts — homogeneous vote aggregation
 * @module evaluation
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Identifies a model participant in cross-model verification.
 * Uses provider+model pair to ensure true independence (different provider = different inference stack).
 */
export interface ModelParticipant {
  readonly providerId: string;
  readonly modelId: string;
  readonly role: 'primary' | 'reviewer';
}

/**
 * A single model's verdict on the verification query.
 */
export interface ModelVerdict {
  readonly participant: ModelParticipant;
  readonly verdict: 'approve' | 'revise' | 'reject';
  readonly confidence: number;
  readonly rationale: string;
  readonly concerns: readonly string[];
  readonly durationMs: number;
}

/**
 * Identifies a specific point of disagreement between models.
 */
export interface ModelDisagreement {
  readonly aspect: string;
  readonly primaryPosition: string;
  readonly reviewerPosition: string;
  readonly severity: 'minor' | 'major' | 'critical';
}

/**
 * Final consensus decision from cross-model verification.
 */
export type ConsensusDecision = 'consensus_approve' | 'consensus_revise' | 'consensus_reject' | 'no_consensus';

/**
 * Aggregated result of cross-model consensus verification.
 */
export interface ConsensusResult {
  readonly decision: ConsensusDecision;
  readonly verdicts: readonly ModelVerdict[];
  readonly disagreements: readonly ModelDisagreement[];
  readonly bayesianConfidence: number;
  readonly totalDurationMs: number;
}

/**
 * Configuration for consensus verification behavior.
 */
export interface ConsensusConfig {
  readonly requireDifferentProviders: boolean;
  readonly bayesianWeights?: Readonly<Record<string, number>>;
  readonly timeoutMs?: number;
  readonly minConfidenceThreshold?: number;
}

// ── Interface ──────────────────────────────────────────────────────

export interface IMultiModelConsensus {
  /**
   * Verify content using multiple independent models and aggregate their verdicts.
   *
   * @param query - The content or plan to verify
   * @param participants - Models participating in verification (≥2, at least one reviewer)
   * @param config - Consensus configuration
   * @param correlationId - Request correlation for tracing
   * @returns Aggregated consensus result with per-model verdicts
   */
  consensusVerify(
    query: string,
    participants: readonly ModelParticipant[],
    config: ConsensusConfig,
    correlationId: CorrelationId,
  ): Promise<ConsensusResult>;

  /**
   * Quick binary consensus: do N models agree on a yes/no question?
   *
   * @param question - Binary question to evaluate
   * @param participants - At least 2 models from different providers
   * @param correlationId - Request correlation for tracing
   * @returns true if majority agrees YES
   */
  binaryConsensus(
    question: string,
    participants: readonly ModelParticipant[],
    correlationId: CorrelationId,
  ): Promise<boolean>;
}
