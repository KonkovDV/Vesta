/**
 * ICrossModelShadowConsensus — Domain port for multi-model audit consensus.
 *
 * CC-031 Cross-Model Shadow Consensus: extends CC-022 (CbvShadowAuditor) by
 * requiring consensus from two independently-instantiated LLM models for
 * changes affecting architecture layers 0-2 (system core, domain logic, events).
 * This eliminates "Model Bias" / "groupthink" where a single model confirms
 * errors produced by the same or similar model family.
 *
 * Key Innovation: Multi-Model Consensus Protocol
 *   - Two independent models audit the same proposal in parallel
 *   - Each produces a CbvVerdict independently (no shared context)
 *   - Consensus engine merges verdicts: unanimous PASS or divergence analysis
 *   - Divergent verdicts trigger mandatory human review
 *
 * Consensus Rules:
 *   - Both PASS → ConsensusResult.consensus = 'unanimous_pass'
 *   - Both FAIL → ConsensusResult.consensus = 'unanimous_fail'
 *   - Divergent → ConsensusResult.consensus = 'divergent' (requires escalation)
 *   - One pass_with_warnings → treat as soft divergence
 *
 * Integration Points:
 *   - ICbvShadowAuditor (CC-022) — produces individual CbvVerdicts
 *   - IMultiModelConsensus (CC-002) — Bayesian consensus infrastructure
 *   - LLMAdapterFactory — resolves two distinct model instances
 *
 * Academic Basis:
 *   - Epistemic Context Learning (arXiv:2601.21742, Jan 2026) — calibrated multi-agent trust
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M2 Decomposed Model-Agnostic Prompting
 *   - Stechly et al. (arXiv:2310.12397) — self-critique limitations → external verifier
 *   - Arbiter (arXiv:2603.08993) — prompt interference detection across models
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-031 Cross-Model Shadow Consensus (PUA v5.2 → CBV 2.0)
 * @see src/domain/evaluation/ICbvShadowAuditor.ts — CC-022 single-model audit
 */

// ── Types ──────────────────────────────────────────────────────────

/** Consensus outcome. */
export type ConsensusOutcome =
  | 'unanimous_pass'
  | 'unanimous_fail'
  | 'divergent'
  | 'partial_agreement';

/** A single model's audit identity. */
export interface AuditorIdentity {
  /** Model provider (e.g., 'anthropic', 'openai'). */
  readonly provider: string;
  /** Model identifier (e.g., 'claude-3.5-sonnet', 'gpt-4o'). */
  readonly modelId: string;
  /** Role in the consensus (primary, secondary, or tertiary+). */
  readonly role: 'primary' | 'secondary' | 'tertiary';
}

/** Result of multi-model consensus audit. */
export interface ConsensusResult {
  /** Overall consensus outcome. */
  readonly consensus: ConsensusOutcome;
  /** Primary model's decision. */
  readonly primaryDecision: string;
  /** Secondary model's decision. */
  readonly secondaryDecision: string;
  /** Primary model identity. */
  readonly primaryAuditor: AuditorIdentity;
  /** Secondary model identity. */
  readonly secondaryAuditor: AuditorIdentity;
  /** Risk scenarios unique to each model (not found by the other). */
  readonly uniqueRisks: {
    readonly primaryOnly: readonly string[];
    readonly secondaryOnly: readonly string[];
  };
  /** Shared risk scenarios found by both models. */
  readonly sharedRisks: readonly string[];
  /** Whether human escalation is required (divergent verdicts). */
  readonly requiresHumanReview: boolean;
  /** Combined confidence (0.0-1.0). */
  readonly combinedConfidence: number;
  /** Total audit duration (both models). */
  readonly totalDurationMs: number;
  /** Human-readable consensus summary. */
  readonly summary: string;
  /** Timestamp. */
  readonly auditedAt: string;
}

/** Architecture layer classification for triggering consensus audit. */
export interface LayerClassification {
  /** Architecture layer number (0-9). */
  readonly layer: number;
  /** Layer name. */
  readonly layerName: string;
  /** Whether multi-model consensus is required for this layer. */
  readonly requiresConsensus: boolean;
}

/** Configuration for cross-model consensus. */
export interface CrossModelConfig {
  /** Maximum architecture layer that requires consensus (default: 2). */
  readonly maxLayerForConsensus: number;
  /** Whether to always require consensus for DI token changes (default: true). */
  readonly consensusForDiChanges: boolean;
  /** Whether to always require consensus for event schema changes (default: true). */
  readonly consensusForSchemaChanges: boolean;
  /** Timeout for each model audit in milliseconds (default: 30000). */
  readonly perModelTimeoutMs: number;
}

/** Default configuration. */
export const DEFAULT_CROSS_MODEL_CONFIG: CrossModelConfig = {
  maxLayerForConsensus: 2,
  consensusForDiChanges: true,
  consensusForSchemaChanges: true,
  perModelTimeoutMs: 30000,
};

/** A single committee member's verdict (N-model Bayesian consensus). */
export interface CommitteeVerdict {
  /** Auditor identity. */
  readonly auditor: AuditorIdentity;
  /** Pass or fail decision. */
  readonly decision: 'pass' | 'fail';
  /** Confidence in the decision (0.0-1.0). */
  readonly confidence: number;
  /** Bayesian weight for this auditor (sum of all weights should be ~1.0). */
  readonly bayesianWeight: number;
  /** Risk scenarios identified. */
  readonly risks: readonly string[];
}

/** Result of N-model Bayesian Committee consensus. */
export interface BayesianCommitteeResult {
  /** Final committee decision. */
  readonly finalDecision: 'pass' | 'fail';
  /** Bayesian-weighted confidence. */
  readonly bayesianConfidence: number;
  /** Whether 2/3+ supermajority was reached. */
  readonly supermajorityReached: boolean;
  /** Whether human review is required (no supermajority). */
  readonly requiresHumanReview: boolean;
  /** Individual verdicts from committee members. */
  readonly verdicts: readonly CommitteeVerdict[];
  /** Risks identified by majority of models. */
  readonly majorityRisks: readonly string[];
  /** Risks identified by minority only. */
  readonly minorityRisks: readonly string[];
  /** Total audit duration. */
  readonly totalDurationMs: number;
  /** Timestamp. */
  readonly auditedAt: string;
}

/** Statistics about consensus auditing. */
export interface CrossModelStats {
  /** Total consensus audits performed. */
  readonly totalAudits: number;
  /** Unanimous pass count. */
  readonly unanimousPassCount: number;
  /** Unanimous fail count. */
  readonly unanimousFailCount: number;
  /** Divergent count. */
  readonly divergentCount: number;
  /** Human escalation count. */
  readonly humanEscalationCount: number;
  /** Average combined confidence. */
  readonly avgConfidence: number;
  /** Total committee audits (3+ models). */
  readonly committeeAudits: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Cross-Model Shadow Consensus — multi-model audit for high-criticality changes.
 *
 * Requires two independent LLM models to agree on the safety of changes
 * affecting architecture layers 0-2, eliminating single-model bias.
 */
export interface ICrossModelShadowConsensus {
  /**
   * Classify the architecture layer of a file.
   *
   * @param filePath - File path to classify
   * @returns Layer classification with consensus requirement
   */
  classifyLayer(filePath: string): LayerClassification;

  /**
   * Determine whether a set of changes requires multi-model consensus.
   *
   * @param affectedFiles - Files affected by the change
   * @param changeKind - Kind of change (from CbvProposal)
   * @param config - Configuration
   * @returns Whether consensus is required and why
   */
  requiresConsensus(
    affectedFiles: readonly string[],
    changeKind: string,
    config?: CrossModelConfig,
  ): { required: boolean; reason: string };

  /**
   * Perform consensus audit using two model verdicts.
   *
   * @param primaryVerdict - Verdict from primary model (decision + risks)
   * @param secondaryVerdict - Verdict from secondary model (decision + risks)
   * @param primaryAuditor - Primary model identity
   * @param secondaryAuditor - Secondary model identity
   * @param durationMs - Total audit duration
   * @returns Consensus result
   */
  evaluateConsensus(
    primaryVerdict: { decision: string; risks: readonly string[] },
    secondaryVerdict: { decision: string; risks: readonly string[] },
    primaryAuditor: AuditorIdentity,
    secondaryAuditor: AuditorIdentity,
    durationMs: number,
  ): ConsensusResult;

  /**
   * Get statistics.
   */
  getStats(): CrossModelStats;

  /** Reset all state. */
  reset(): void;

  /**
   * Evaluate N-model Bayesian Committee consensus (3+ models).
   *
   * @param verdicts - Array of independently-produced verdicts
   * @param durationMs - Total audit duration
   * @returns Bayesian committee consensus result
   */
  evaluateCommittee(
    verdicts: readonly CommitteeVerdict[],
    durationMs: number,
  ): BayesianCommitteeResult;
}
