/**
 * IBFTErrorRouter — Domain port for Byzantine Fault Tolerant error routing.
 *
 * When an agent generates potentially erroneous code (AST diff before/after
 * shows unexpected mutations), instead of Fail-Fast, the change is routed
 * to a "Tribunal" of evaluator judges for consensus voting.
 *
 * BFT model: 2/3 supermajority required for acceptance (Soft-Merge).
 * Extends existing IVotingAggregator pattern with adversarial Red Teaming.
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @vector V3: Multi-Agent Consensus Debugging
 * @horizon Q1 2027
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §4
 * @see IVotingAggregator — base consensus interface
 * @see IRecoveryStrategy — fallback when tribunal rejects
 */

import type { CorrelationId } from '@/ai-types';

// ── Types ─────────────────────────────────────────────────────────

/** A code change submitted for BFT consensus. */
export interface CodeChangeSubmission {
  /** Unique submission ID. */
  readonly submissionId: string;
  /** File path relative to workspace. */
  readonly filePath: string;
  /** Unified diff of the change. */
  readonly diff: string;
  /** AST diff summary (nodes added/removed/modified). */
  readonly astDiffSummary: string;
  /** The agent that generated the change. */
  readonly agentId: string;
  /** Correlation ID for tracing. */
  readonly correlationId: CorrelationId;
}

/** Verdict from a single judge. */
export type JudgeVerdict = 'ACCEPT' | 'REJECT' | 'ABSTAIN';

/** A single judge's evaluation of a code change. */
export interface JudgeEvaluation {
  /** Judge identifier (model name or agent ID). */
  readonly judgeId: string;
  /** The verdict. */
  readonly verdict: JudgeVerdict;
  /** Confidence (0.0–1.0). */
  readonly confidence: number;
  /** Reasoning for the verdict. */
  readonly reasoning: string;
  /** Optional: AST patch suggested if verdict is REJECT. */
  readonly suggestedPatch?: string;
  /** Evaluation latency in ms. */
  readonly latencyMs: number;
}

/** Consensus result from the tribunal. */
export type ConsensusOutcome = 'ACCEPTED' | 'REJECTED' | 'NO_QUORUM';

/** Result of BFT consensus on a code change. */
export interface BFTConsensusResult {
  /** Overall outcome. */
  readonly outcome: ConsensusOutcome;
  /** Individual judge evaluations. */
  readonly evaluations: readonly JudgeEvaluation[];
  /** Acceptance ratio (accepts / total non-abstain). */
  readonly acceptanceRatio: number;
  /** Synthesized root cause (if rejected). */
  readonly rootCauseSynthesis?: string;
  /** Auto-generated fix patch (if rejected, from reflection loop). */
  readonly autoFixPatch?: string;
}

// ── Port ──────────────────────────────────────────────────────────

/**
 * Routes code changes through BFT consensus when Fail-Fast would
 * be too aggressive. Enables graceful multi-agent error handling.
 */
export interface IBFTErrorRouter {
  /**
   * Submit a code change for BFT consensus evaluation.
   * Internally dispatches to multiple judge models, collects verdicts,
   * and applies 2/3 supermajority rule.
   */
  evaluateChange(
    submission: CodeChangeSubmission,
    correlationId: CorrelationId,
  ): Promise<BFTConsensusResult>;

  /**
   * Apply the auto-fix patch from a rejected submission's reflection loop.
   * Only valid when outcome was REJECTED and autoFixPatch is present.
   */
  applyAutoFix(
    submissionId: string,
    correlationId: CorrelationId,
  ): Promise<boolean>;

  /**
   * Get historical consensus results for audit.
   */
  getHistory(
    limit: number,
    correlationId: CorrelationId,
  ): Promise<readonly BFTConsensusResult[]>;
}
