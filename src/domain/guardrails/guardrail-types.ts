/**
 * Shared types for Input/Output Guardrail Pipelines.
 *
 * Extracted to avoid cross-file coupling between pipeline interfaces.
 *
 * @layer Domain (depends only on Core)
 * @see Book Ch.18 "Safety & Security"
 * @see NeMo Guardrails v0.20 5-layer model
 */

// ── Shared Value Objects ────────────────────────────────────────────

/** Severity levels for guardrail violations (NeMo-aligned) */
export type RailSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Result of a single guardrail check within a pipeline */
export interface GuardrailCheckResult {
  /** Name of the scanner/guardrail that produced this result */
  readonly scannerName: string;
  /** Whether this check passed (no violation found) */
  readonly passed: boolean;
  /** Severity of the violation (only meaningful if passed=false) */
  readonly severity: RailSeverity;
  /** Human-readable details about the finding */
  readonly details?: string;
}

/** Aggregate result from running an entire guardrail pipeline */
export interface PipelineResult {
  /** Whether the content is allowed to proceed */
  readonly allowed: boolean;
  /** Results from each individual check in the pipeline */
  readonly checks: readonly GuardrailCheckResult[];
  /** Name of the scanner that blocked content (if blocked) */
  readonly blockedBy?: string;
  /** Sanitized version of the input/output (if available) */
  readonly sanitizedContent?: string;
}
