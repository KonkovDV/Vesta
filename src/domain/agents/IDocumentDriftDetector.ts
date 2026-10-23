/**
 * IDocumentDriftDetector — Domain port for self-maintaining documentation systems.
 *
 * CC-015 Self-Maintaining Documentation: detects drift between source-of-truth
 * and dependent documents, manages self-evolving verification rules that grow
 * from real failures, and checks cross-document consistency of shared claims.
 *
 * SOTA 2026 Basis: Claude Code's workflow-coordinator pattern spawns parallel
 * research agents, merges findings with confidence scores, tracks recurring
 * issues across runs, and evolves verification checklists from incidents.
 *
 * Sub-capabilities:
 *   1. Drift Detection — confidence-scored findings (0.0–1.0)
 *   2. Cross-Document Consistency — claim verification across file set
 *   3. Self-Evolving Verification Rules — rules grow from real failures
 *   4. Append-only Audit Trail — findings tracked as NEW/RECURRING/RESOLVED
 *   5. Self-Evolution — detector improves its own rules after each run
 *
 * @layer Domain (Agents)
 * @pattern CC-015 Self-Maintaining Docs (FITNESS-K: 84.5)
 * @see src/domain/audit/ICriticFeedbackService.ts — feedback events companion
 * @see src/domain/events/event-store.interface.ts — event-sourced audit trail
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

/**
 * Severity of a drift finding, from critical to informational.
 */
export type DriftSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Category of drift detected.
 */
export type DriftCategory =
  | 'missing'
  | 'changed'
  | 'deprecated'
  | 'inconsistency'
  | 'stale-link';

/**
 * Lifecycle status of a finding across audit runs.
 */
export type FindingStatus = 'new' | 'recurring' | 'resolved';

/**
 * Depth at which a verification rule checks documents.
 */
export type VerificationDepth = 'surface' | 'deep' | 'cross-reference';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single drift finding with confidence score.
 */
export interface DriftFinding {
  readonly findingId: string;
  readonly documentPath: string;
  readonly category: DriftCategory;
  readonly severity: DriftSeverity;
  readonly description: string;
  /** Confidence in finding accuracy, 0.0 (uncertain) to 1.0 (certain). */
  readonly confidence: number;
  readonly status: FindingStatus;
  readonly suggestedFix?: string;
  /** ISO timestamp when finding first appeared (for recurring tracking). */
  readonly firstSeenAt?: string;
  readonly detectedAt: string;
}

/**
 * Result of cross-document consistency check for a single claim.
 */
export interface CrossReferenceCheck {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly claim: string;
  readonly consistent: boolean;
  readonly details?: string;
}

/**
 * A verification rule that evolves from discovered issues.
 * Each rule includes provenance: what incident caused its creation.
 */
export interface VerificationRule {
  readonly ruleId: string;
  readonly category: string;
  readonly description: string;
  readonly depth: VerificationDepth;
  readonly sourceToCompare: string;
  readonly origin: string;
  readonly addedAt: string;
}

/**
 * Request parameters for drift detection.
 */
export interface DriftDetectionRequest {
  readonly documentPaths: readonly string[];
  readonly sourcesOfTruth?: readonly string[];
  readonly checkCrossReferences: boolean;
  readonly minConfidence?: number;
}

/**
 * Complete drift report from a detection run.
 */
export interface DriftReport {
  readonly reportId: string;
  readonly findings: readonly DriftFinding[];
  readonly crossReferences: readonly CrossReferenceCheck[];
  readonly rulesApplied: number;
  readonly documentsScanned: number;
  readonly generatedAt: string;
}

/**
 * Input for a cross-document consistency claim check.
 */
export interface ConsistencyClaimInput {
  readonly claim: string;
  readonly documentPaths: readonly string[];
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * IDocumentDriftDetector — self-maintaining documentation with evolving verification.
 *
 * Workflow:
 * 1. detectDrift() scans documents against verification rules
 * 2. Each finding gets confidence score + NEW/RECURRING/RESOLVED status
 * 3. checkCrossDocConsistency() verifies shared claims across files
 * 4. addVerificationRule() captures new rules from discovered issues
 * 5. Rules accumulate over time, improving detection coverage
 */
export interface IDocumentDriftDetector {
  /**
   * Detect drift between documents and their sources of truth.
   * Applies all verification rules and returns confidence-scored findings.
   *
   * @param request - Documents to scan, optional source-of-truth references
   * @param correlationId - Request correlation for tracing
   * @returns Report with findings, cross-references, and rule count
   */
  detectDrift(request: DriftDetectionRequest, correlationId: string): Promise<DriftReport>;

  /**
   * Get all active verification rules.
   *
   * @returns Ordered list of rules (oldest first)
   */
  getVerificationRules(): VerificationRule[];

  /**
   * Add a new verification rule derived from a discovered issue.
   *
   * @param rule - Rule without auto-generated ruleId
   * @returns Created rule with generated ruleId
   */
  addVerificationRule(rule: Omit<VerificationRule, 'ruleId'>): VerificationRule;

  /**
   * Remove a verification rule by ID.
   *
   * @param ruleId - Rule to remove
   * @returns true if removed, false if not found
   */
  removeVerificationRule(ruleId: string): boolean;

  /**
   * Check cross-document consistency for a set of claims.
   * For each claim, verifies it is consistent across all specified documents.
   *
   * @param claims - Array of {claim, documentPaths} to verify
   * @returns Cross-reference check results for each claim+document pair
   */
  checkCrossDocConsistency(claims: readonly ConsistencyClaimInput[]): Promise<CrossReferenceCheck[]>;
}
