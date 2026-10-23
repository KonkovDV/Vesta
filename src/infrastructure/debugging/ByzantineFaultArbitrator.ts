/**
 * ByzantineFaultArbitrator — Infrastructure adapter for IBFTErrorRouter.
 *
 * Implements the Two-Tool Verification Protocol with cryptographic approval_token:
 *   1. Agent submits a code change
 *   2. Multiple judge evaluators vote (2/3 supermajority BFT rule)
 *   3. If accepted, generates a SHA-256 HMAC approval_token
 *   4. Token is time-bounded (5min TTL) and single-use (nonce replay prevention)
 *
 * The approval_token cryptographically proves that the Two-Tool Protocol
 * was followed and consensus was reached. Token structure:
 *   HMAC-SHA256(submissionId + outcome + timestamp + nonce, secret)
 *
 * Security model:
 *   - Tokens are non-forgeable (HMAC with server-held secret)
 *   - Tokens expire after 5 minutes (TTL)
 *   - Tokens are single-use (nonce tracking prevents replay)
 *   - Token verification is constant-time (timing attack prevention)
 *
 * @layer Infrastructure
 * @implements IBFTErrorRouter (Domain port)
 * @see src/domain/debugging/IBFTErrorRouter.ts
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §4
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CorrelationId } from '@/ai-types';
import type {
  IBFTErrorRouter,
  CodeChangeSubmission,
  JudgeEvaluation,
  JudgeVerdict,
  BFTConsensusResult,
  ConsensusOutcome,
} from '../../domain/debugging/IBFTErrorRouter';

// ── Types ─────────────────────────────────────────────────────────

/** An approval token issued after successful BFT consensus. */
export interface ApprovalToken {
  /** The token value (hex-encoded HMAC). */
  readonly token: string;
  /** Submission ID this token authorizes. */
  readonly submissionId: string;
  /** Consensus outcome. */
  readonly outcome: ConsensusOutcome;
  /** ISO-8601 timestamp of issuance. */
  readonly issuedAt: string;
  /** ISO-8601 timestamp of expiry. */
  readonly expiresAt: string;
  /** Cryptographic nonce (prevents replay). */
  readonly nonce: string;
}

/** Verification result for an approval token. */
export interface TokenVerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly submissionId?: string;
  readonly outcome?: ConsensusOutcome;
}

/** Judge configuration for the tribunal. */
export interface JudgeConfig {
  readonly judgeId: string;
  readonly evaluator: (submission: CodeChangeSubmission) => Promise<JudgeEvaluation>;
  /**
   * Dynamic trust weight for WBFT (Weighted BFT).
   * Range [0.0, 1.0]. Default: 1.0 (equal weight).
   * Grows when judge aligns with final consensus, decays on disagreement.
   * @see arXiv: "Trusted Multi-LLM Networks" (2025)
   */
  trustWeight?: number;
}

// ── Logger Interface ──────────────────────────────────────────────

interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Constants ─────────────────────────────────────────────────────

/** Token TTL in milliseconds (5 minutes). */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** BFT threshold: 2/3 supermajority. */
const BFT_THRESHOLD = 2 / 3;

/** Maximum history entries retained. */
const MAX_HISTORY = 100;

/** Trust weight increment when judge aligns with consensus (WBFT). */
const TRUST_REWARD = 0.05;

/** Trust weight decrement when judge disagrees with consensus (WBFT). */
const TRUST_PENALTY = 0.10;

/** Minimum trust weight floor (prevents total silencing). */
const MIN_TRUST_WEIGHT = 0.1;

/** Maximum trust weight ceiling. */
const MAX_TRUST_WEIGHT = 1.0;

/** Default trust weight for new judges. */
const DEFAULT_TRUST_WEIGHT = 1.0;

/**
 * Gossip Debate Protocol: whether to enable two-phase voting.
 * Phase 1: Blind draft verdicts. Phase 2: Share rejections → re-vote.
 * Enabled by default (SOTA 2026: Debate BFT gives 96% vs 85% accuracy).
 */
const GOSSIP_ENABLED = true;

// ── Implementation ────────────────────────────────────────────────

export class ByzantineFaultArbitrator implements IBFTErrorRouter {
  private readonly history: Array<BFTConsensusResult & { submissionId?: string }> = [];
  private readonly usedNonces: Map<string, number> = new Map(); // nonce → issuedAt timestamp
  private readonly hmacSecret: Buffer;
  /** Mutable trust weights per judge (WBFT adaptive scoring). */
  private readonly trustWeights: Map<string, number> = new Map();
  /** Whether gossip debate protocol is enabled. */
  private readonly gossipEnabled: boolean;

  constructor(
    private readonly judges: readonly JudgeConfig[],
    hmacSecret?: string,
    private readonly logger?: ILogger,
    gossipEnabled?: boolean,
  ) {
    // Use provided secret or generate ephemeral one (development mode)
    this.hmacSecret = Buffer.from(hmacSecret ?? randomBytes(32).toString('hex'), 'utf8');
    this.gossipEnabled = gossipEnabled ?? GOSSIP_ENABLED;

    // Initialize trust weights from config or defaults (WBFT)
    for (const judge of judges) {
      this.trustWeights.set(judge.judgeId, judge.trustWeight ?? DEFAULT_TRUST_WEIGHT);
    }
  }

  async evaluateChange(
    submission: CodeChangeSubmission,
    correlationId: CorrelationId,
  ): Promise<BFTConsensusResult> {
    this.logger?.info('BFT: evaluating change submission', {
      correlationId,
      submissionId: submission.submissionId,
      file: submission.filePath,
      agentId: submission.agentId,
      judgeCount: this.judges.length,
      gossipEnabled: this.gossipEnabled,
    });

    const t0 = Date.now();

    // ── Phase 1: Blind Draft Verdicts ─────────────────────────
    const draftEvaluations = await this.evaluateAllJudges(submission, t0);

    // Calculate draft consensus
    const draftConsensus = this.calculateWBFTConsensus(draftEvaluations);

    let finalEvaluations: JudgeEvaluation[];

    // ── Phase 2: Gossip Protocol (if enabled and no immediate consensus) ──
    if (
      this.gossipEnabled &&
      draftConsensus.outcome !== 'NO_QUORUM' &&
      this.hasDisagreement(draftEvaluations)
    ) {
      // Build gossip summary: share rejection reasons with all judges
      const gossipSummary = this.buildGossipSummary(draftEvaluations);

      this.logger?.info('BFT: Gossip Phase 2 — sharing rejection reasons', {
        correlationId,
        gossipLength: gossipSummary.length,
        rejectCount: draftEvaluations.filter((e) => e.verdict === 'REJECT').length,
      });

      // Re-evaluate with gossip context (enriched submission)
      const enrichedSubmission: CodeChangeSubmission = {
        ...submission,
        astDiffSummary: `${submission.astDiffSummary}\n\n--- Gossip Round ---\n${gossipSummary}`,
      };

      finalEvaluations = await this.evaluateAllJudges(enrichedSubmission, t0);
    } else {
      finalEvaluations = draftEvaluations;
    }

    // ── Final WBFT Consensus ──────────────────────────────────
    const { outcome, acceptanceRatio, accepts } = this.calculateWBFTConsensus(finalEvaluations);

    // Synthesize root cause from rejections
    let rootCauseSynthesis: string | undefined;
    let autoFixPatch: string | undefined;

    if (outcome === 'REJECTED') {
      const rejections = finalEvaluations.filter((e) => e.verdict === 'REJECT');
      rootCauseSynthesis = rejections.map((r) => `[${r.judgeId}] ${r.reasoning}`).join('; ');
      autoFixPatch = rejections.find((r) => r.suggestedPatch)?.suggestedPatch;
    }

    const result: BFTConsensusResult = {
      outcome,
      evaluations: finalEvaluations,
      acceptanceRatio,
      rootCauseSynthesis,
      autoFixPatch,
    };

    // WBFT: adaptive trust weight update per judge
    this.updateTrustWeights(finalEvaluations, outcome);

    // Store in history (bounded) with submissionId for lookup
    const historyEntry = Object.assign({}, result, { submissionId: submission.submissionId });
    this.history.push(historyEntry);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    this.logger?.info('BFT: consensus reached', {
      correlationId,
      submissionId: submission.submissionId,
      outcome,
      acceptanceRatio: acceptanceRatio.toFixed(2),
      judges: finalEvaluations.length,
      accepts: accepts.length,
      gossipUsed: this.gossipEnabled && this.hasDisagreement(draftEvaluations),
      durationMs: Date.now() - t0,
    });

    return result;
  }

  async applyAutoFix(
    submissionId: string,
    correlationId: CorrelationId,
  ): Promise<boolean> {
    this.logger?.info('BFT: applying auto-fix', { correlationId, submissionId });

    // Find the result with autoFixPatch matching this submissionId
    const result = this.history.find(
      (r) => r.submissionId === submissionId && r.outcome === 'REJECTED' && r.autoFixPatch,
    );

    if (!result?.autoFixPatch) {
      this.logger?.warn('BFT: no auto-fix available', { correlationId, submissionId });
      return false;
    }

    // In a full implementation, this would apply the patch to the file.
    // For now, return true to indicate the patch is available.
    this.logger?.info('BFT: auto-fix patch available', {
      correlationId,
      submissionId,
      patchLength: result.autoFixPatch.length,
    });

    return true;
  }

  async getHistory(
    limit: number,
    correlationId: CorrelationId,
  ): Promise<readonly BFTConsensusResult[]> {
    this.logger?.info('BFT: getting history', { correlationId, limit });
    return this.history.slice(-Math.max(1, Math.min(limit, MAX_HISTORY)));
  }

  // ── Gossip Protocol Helpers ──────────────────────────────────

  /**
   * Dispatch submission to all judges concurrently (shared between Phase 1 & 2).
   */
  private async evaluateAllJudges(
    submission: CodeChangeSubmission,
    t0: number,
  ): Promise<JudgeEvaluation[]> {
    const evaluationPromises = this.judges.map(async (judge) => {
      try {
        return await judge.evaluator(submission);
      } catch (err) {
        return {
          judgeId: judge.judgeId,
          verdict: 'ABSTAIN' as JudgeVerdict,
          confidence: 0,
          reasoning: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
          latencyMs: Date.now() - t0,
        };
      }
    });

    const settled = await Promise.allSettled(evaluationPromises);
    return settled
      .filter((r): r is PromiseFulfilledResult<JudgeEvaluation> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * Calculate WBFT consensus from evaluations.
   */
  private calculateWBFTConsensus(evaluations: JudgeEvaluation[]): {
    outcome: ConsensusOutcome;
    acceptanceRatio: number;
    accepts: JudgeEvaluation[];
  } {
    const nonAbstain = evaluations.filter((e) => e.verdict !== 'ABSTAIN');
    const accepts = nonAbstain.filter((e) => e.verdict === 'ACCEPT');

    if (nonAbstain.length === 0) {
      return { outcome: 'NO_QUORUM', acceptanceRatio: 0, accepts: [] };
    }

    let acceptWeight = 0;
    let totalWeight = 0;
    for (const evaluation of nonAbstain) {
      const weight = this.trustWeights.get(evaluation.judgeId) ?? DEFAULT_TRUST_WEIGHT;
      totalWeight += weight;
      if (evaluation.verdict === 'ACCEPT') {
        acceptWeight += weight;
      }
    }

    const acceptanceRatio = totalWeight > 0 ? acceptWeight / totalWeight : 0;
    const outcome: ConsensusOutcome = acceptanceRatio >= BFT_THRESHOLD ? 'ACCEPTED' : 'REJECTED';

    return { outcome, acceptanceRatio, accepts };
  }

  /**
   * Check if there is disagreement among judges (not unanimous).
   */
  private hasDisagreement(evaluations: JudgeEvaluation[]): boolean {
    const nonAbstain = evaluations.filter((e) => e.verdict !== 'ABSTAIN');
    if (nonAbstain.length <= 1) return false;

    const firstVerdict = nonAbstain[0].verdict;
    return nonAbstain.some((e) => e.verdict !== firstVerdict);
  }

  /**
   * Build gossip summary from rejection reasons (Debate BFT Phase 2).
   * Shares anonymized rejection arguments with all judges for re-evaluation.
   */
  private buildGossipSummary(evaluations: JudgeEvaluation[]): string {
    const rejections = evaluations.filter((e) => e.verdict === 'REJECT');

    if (rejections.length === 0) return '';

    const lines = rejections.map(
      (r) => `Judge ${r.judgeId} (confidence: ${r.confidence.toFixed(2)}) REJECTED: ${r.reasoning}`,
    );

    return lines.join('\n');
  }

  // ── Approval Token System ──────────────────────────────────────

  /**
   * Issue a cryptographic approval token after successful consensus.
   * Token is HMAC-SHA256 signed, time-bounded, and single-use.
   */
  issueApprovalToken(
    submissionId: string,
    outcome: ConsensusOutcome,
  ): ApprovalToken {
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    const payload = `${submissionId}:${outcome}:${issuedAt}:${nonce}`;
    const token = createHmac('sha256', this.hmacSecret)
      .update(payload)
      .digest('hex');

    this.logger?.info('BFT: approval token issued', {
      submissionId,
      outcome,
      nonce: nonce.slice(0, 8) + '...', // Log only prefix
      expiresAt,
    });

    return { token, submissionId, outcome, issuedAt, expiresAt, nonce };
  }

  /**
   * Verify an approval token's authenticity, expiry, and single-use constraint.
   * Uses constant-time comparison to prevent timing attacks.
   */
  verifyApprovalToken(approvalToken: ApprovalToken): TokenVerificationResult {
    // Check expiry — derive from HMAC-protected issuedAt, not client-supplied expiresAt (CWE-345)
    const now = Date.now();
    const expiryTime = new Date(approvalToken.issuedAt).getTime() + TOKEN_TTL_MS;
    if (now > expiryTime) {
      return { valid: false, reason: 'Token expired' };
    }

    // Check nonce replay
    if (this.usedNonces.has(approvalToken.nonce)) {
      return { valid: false, reason: 'Token already used (nonce replay)' };
    }

    // Recompute HMAC and compare
    const payload = `${approvalToken.submissionId}:${approvalToken.outcome}:${approvalToken.issuedAt}:${approvalToken.nonce}`;
    const expected = createHmac('sha256', this.hmacSecret)
      .update(payload)
      .digest('hex');

    const tokenBuf = Buffer.from(approvalToken.token, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      return { valid: false, reason: 'Token signature invalid' };
    }

    // Mark nonce as used (single-use enforcement)
    this.usedNonces.set(approvalToken.nonce, Date.now());

    // Evict expired nonces to prevent memory growth (keep TTL window)
    if (this.usedNonces.size > 1_000) {
      this.evictExpiredNonces();
    }

    return {
      valid: true,
      submissionId: approvalToken.submissionId,
      outcome: approvalToken.outcome,
    };
  }

  /**
   * Evict nonces older than TOKEN_TTL_MS to bound memory.
   * Only removes provably expired nonces — no replay window.
   */
  private evictExpiredNonces(): void {
    const cutoff = Date.now() - TOKEN_TTL_MS;
    for (const [nonce, timestamp] of this.usedNonces) {
      if (timestamp < cutoff) {
        this.usedNonces.delete(nonce);
      }
    }
  }

  // ── WBFT: Adaptive Trust Weight System ──────────────────────

  /**
   * Update trust weights after consensus (WBFT — Weighted BFT).
   *
   * Judges that aligned with the final outcome get a trust reward;
   * judges that disagreed get a trust penalty. Weights are clamped
   * to [MIN_TRUST_WEIGHT, MAX_TRUST_WEIGHT].
   *
   * @see arXiv: "Trusted Multi-LLM Networks" (2025) — §3.2 Adaptive Weighting
   */
  private updateTrustWeights(
    evaluations: JudgeEvaluation[],
    outcome: ConsensusOutcome,
  ): void {
    if (outcome === 'NO_QUORUM') return; // No update on no-quorum

    const consensusVerdict: JudgeVerdict = outcome === 'ACCEPTED' ? 'ACCEPT' : 'REJECT';

    for (const evaluation of evaluations) {
      if (evaluation.verdict === 'ABSTAIN') continue;

      const current = this.trustWeights.get(evaluation.judgeId) ?? DEFAULT_TRUST_WEIGHT;
      let updated: number;

      if (evaluation.verdict === consensusVerdict) {
        // Reward: scale by confidence (high-confidence correct alignment ≫ low-confidence)
        updated = current + TRUST_REWARD * evaluation.confidence;
      } else {
        // Penalty: scale by confidence (high-confidence wrong vote = bigger penalty)
        updated = current - TRUST_PENALTY * evaluation.confidence;
      }

      // Clamp to valid range
      updated = Math.max(MIN_TRUST_WEIGHT, Math.min(MAX_TRUST_WEIGHT, updated));
      this.trustWeights.set(evaluation.judgeId, updated);
    }
  }

  /**
   * Get current trust weight for a judge (for inspection/testing).
   */
  getTrustWeight(judgeId: string): number {
    return this.trustWeights.get(judgeId) ?? DEFAULT_TRUST_WEIGHT;
  }

  /**
   * Get all trust weights (for monitoring/observability).
   */
  getAllTrustWeights(): ReadonlyMap<string, number> {
    return this.trustWeights;
  }

  /**
   * Externally penalize a judge's trust weight (used by ChaosMonkeyAgent).
   * Penalty is clamped to [MIN_TRUST_WEIGHT, MAX_TRUST_WEIGHT].
   */
  penalizeTrust(judgeId: string, penalty: number): void {
    const current = this.trustWeights.get(judgeId) ?? DEFAULT_TRUST_WEIGHT;
    const updated = Math.max(MIN_TRUST_WEIGHT, current - Math.abs(penalty));
    this.trustWeights.set(judgeId, updated);
  }
}
