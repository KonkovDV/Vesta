/**
 * ICbvShadowAuditor — Domain port for Consensus-Based Verification via Shadow Auditing.
 *
 * CC-022 CBV Shadow Auditor: addresses the fundamental limitation identified in
 * Stechly et al. (arXiv:2310.12397) — LLMs cannot reliably self-verify.
 * Instead of the same agent verifying its own work, a secondary LLM model
 * (the "Shadow Auditor") critiques the proposed plan/change via an independent
 * inference stack.
 *
 * Pipeline:
 *   Agent proposes change → ICbvShadowAuditor.auditProposal()
 *     → Secondary model (via LLMAdapterFactory): Red-Team + Inversion Test
 *     → CbvVerdict: PASS/FAIL with evidence chain + risk scenarios
 *     → Agent proceeds (PASS) or pivots (FAIL)
 *
 * Academic Basis:
 *   - Stechly et al. (arXiv:2310.12397) — self-critique without external verifier = illusory
 *   - Farquhar/DeepMind MONA (arXiv:2501.13011) — myopic fix + non-myopic approval
 *   - Sharma/Anthropic (arXiv:2310.13548) — anti-sycophancy via independent review
 *   - Mouzouni (arXiv:2602.21368) — self-consistency sampling for reliability certification
 *
 * Integration Points:
 *   - IMultiModelConsensus (CC-002) — cross-model verification infrastructure
 *   - IExecutionProvenanceTracer (CC-019) — evidence chain citations
 *   - ICriticFeedbackService — AST-enriched error context
 *   - LLMAdapterFactory — secondary model resolution
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-022 CBV Shadow Auditor (PUA Phase 12 → codified)
 * @see .github/instructions/pua-exhaustive-debugging.instructions.md — CBV Protocol
 */

// ── Types ──────────────────────────────────────────────────────────

/** The kind of change being audited. */
export type ChangeKind =
  | 'code_edit'        // Source file modification
  | 'di_registration'  // DI token/module change
  | 'schema_change'    // Zod/event schema modification
  | 'config_change'    // Configuration change
  | 'architecture';    // Cross-layer structural change

/** Severity of a risk scenario identified by the Shadow Auditor. */
export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';

/** A concrete risk scenario identified during red-teaming. */
export interface RedTeamScenario {
  /** Short description of the scenario. */
  readonly description: string;
  /** How this scenario could break existing functionality. */
  readonly impact: string;
  /** Severity assessment. */
  readonly severity: RiskSeverity;
  /** Affected files or components. */
  readonly affectedAreas: readonly string[];
  /** Suggested mitigation. */
  readonly mitigation?: string;
}

/** Result of the Inversion Test — arguing the opposite of the proposed fix. */
export interface InversionTestResult {
  /** The counter-argument constructed by the Shadow Auditor. */
  readonly counterArgument: string;
  /** Was the counter-argument stronger than the original proposal? */
  readonly counterArgumentStronger: boolean;
  /** Reasoning for the strength assessment. */
  readonly strengthRationale: string;
}

/** A single piece of evidence linking a claim to a tool output. */
export interface EvidenceLink {
  /** The claim being supported. */
  readonly claim: string;
  /** Source type: file read, grep result, test output. */
  readonly sourceType: 'file_read' | 'grep_result' | 'test_output' | 'terminal_output';
  /** File path or command. */
  readonly source: string;
  /** Relevant line range. */
  readonly lineRange?: { readonly start: number; readonly end: number };
  /** Content snippet supporting the claim. */
  readonly snippet?: string;
}

/** The overall CBV verdict. */
export type CbvDecision = 'pass' | 'fail' | 'pass_with_warnings';

/** The proposal submitted for CBV audit. */
export interface CbvProposal {
  /** Description of the proposed change. */
  readonly description: string;
  /** Kind of change. */
  readonly changeKind: ChangeKind;
  /** Files affected by the change. */
  readonly affectedFiles: readonly string[];
  /** The diff or summary of changes. */
  readonly changeSummary: string;
  /** PUA pressure level at the time of proposal (if applicable). */
  readonly puaLevel?: 0 | 1 | 2 | 3 | 4;
  /** Correlation ID for tracing. */
  readonly correlationId?: string;
}

/** Complete CBV audit result. */
export interface CbvVerdict {
  /** Overall decision. */
  readonly decision: CbvDecision;
  /** Red-team scenarios identified. */
  readonly redTeamScenarios: readonly RedTeamScenario[];
  /** Inversion test result. */
  readonly inversionTest: InversionTestResult;
  /** Evidence chain linking claims to tool outputs. */
  readonly evidenceChain: readonly EvidenceLink[];
  /** Model used for shadow audit (provider + model ID). */
  readonly auditorModel: string;
  /** Whether anti-sycophancy checks passed. */
  readonly antiSycophancyCheck: boolean;
  /** Audit duration in milliseconds. */
  readonly durationMs: number;
  /** Formatted summary for agent display. */
  readonly summary: string;
  /** Timestamp of the audit. */
  readonly auditedAt: string;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * CBV Shadow Auditor — adversarial self-audit via independent model review.
 *
 * Implements the CBV (Consensus-Based Verification) protocol from PUA Phase 12
 * as a formal domain port, enabling automated adversarial review of agent
 * proposals before execution.
 */
export interface ICbvShadowAuditor {
  /**
   * Audit a proposed change via an independent model.
   *
   * The Shadow Auditor:
   * 1. Red-teams the proposal — generates concrete break scenarios
   * 2. Runs an inversion test — argues the opposite of the proposal
   * 3. Builds an evidence chain — links claims to tool outputs
   * 4. Performs anti-sycophancy check — ensures verdict isn't biased by user approval
   *
   * @param proposal - The change proposal to audit
   * @returns The CBV verdict with full audit trail
   */
  auditProposal(proposal: CbvProposal): Promise<CbvVerdict>;

  /**
   * Quick check — lightweight CBV for small changes (< 3 lines of logic).
   * Only runs Evidence Chain (CBV item 3), skips Red-Team and Inversion.
   *
   * @param proposal - The change proposal
   * @returns Partial verdict with evidence chain only
   */
  quickCheck(proposal: CbvProposal): Promise<Pick<CbvVerdict, 'decision' | 'evidenceChain' | 'summary' | 'durationMs'>>;
}
