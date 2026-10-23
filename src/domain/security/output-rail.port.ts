/**
 * Output Rail Scanner — Domain port for detecting policy violations
 * in LLM-generated output (NeMo Guardrails Layer 5).
 *
 * Complements IPromptInjectionScanner (Layer 1, input-side) with
 * **output-side validation** capabilities:
 *  - System prompt leakage detection (OWASP LLM07)
 *  - PII/credential exposure in generated responses
 *  - Hallucinated tool calls and unauthorized actions
 *  - Harmful/toxic content patterns
 *  - Excessive verbosity / data dumping
 *  - Unicode smuggling in output
 *
 * @layer Domain (Security)
 * @phase 0B — Output Rail Scanner (NeMo Layer 5)
 * @owasp LLM07 (System Prompt Leakage), LLM02 (Sensitive Information Disclosure)
 * @see IPromptInjectionScanner for Layer 1 (input-side detection)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Severity level of an output rail violation.
 */
export type OutputRailSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Category of detected output violation.
 */
export type OutputViolationCategory =
  | 'system_prompt_leak'
  | 'pii_exposure'
  | 'credential_leak'
  | 'hallucinated_action'
  | 'harmful_content'
  | 'excessive_disclosure'
  | 'unicode_smuggling'
  | 'boundary_leak'
  | 'instruction_echo';

/**
 * A single detected output violation.
 */
export interface OutputViolation {
  /** Violation category */
  readonly category: OutputViolationCategory;
  /** Human-readable description of the violation */
  readonly description: string;
  /** Severity level */
  readonly severity: OutputRailSeverity;
  /** Zero-based offset of the match in the output */
  readonly offset: number;
  /** Matched fragment (truncated to 120 chars) */
  readonly matchedFragment: string;
  /** Pattern label that triggered the violation */
  readonly patternLabel: string;
}

/**
 * Result of scanning LLM output for policy violations.
 */
export interface OutputRailScanResult {
  /** Whether all checks passed (no violations) */
  readonly passed: boolean;
  /** Highest severity among all detected violations */
  readonly maxSeverity: OutputRailSeverity | null;
  /** Number of distinct violations */
  readonly violationCount: number;
  /** Individual violations with offset + fragment + label */
  readonly violations: readonly OutputViolation[];
  /** Sanitized output with violations redacted (if sanitization enabled) */
  readonly sanitizedOutput?: string;
  /** Scan duration in milliseconds */
  readonly scanDurationMs: number;
}

/**
 * Configuration for an output rail scan.
 */
export interface OutputRailScanOptions {
  /** Whether to produce sanitized output with violations redacted (default: false) */
  sanitize?: boolean;
  /** Custom system prompt fingerprints to detect leakage (in addition to built-in patterns) */
  systemPromptFingerprints?: readonly string[];
  /** Maximum allowed output length before flagging excessive disclosure (default: 50000) */
  maxOutputLength?: number;
  /** Minimum severity to include in results (default: 'low') */
  minSeverity?: OutputRailSeverity;
}

// ─── Port Interface ──────────────────────────────────────────────────────────

/**
 * Domain contract for output rail scanning (NeMo Layer 5).
 *
 * Implementations MUST:
 * 1. Apply Unicode normalization before matching
 * 2. Use ReDoS-safe regex patterns
 * 3. Return all violations — never short-circuit on first hit
 * 4. Support optional sanitization (redacting matched fragments)
 * 5. Support custom system prompt fingerprints for project-specific leak detection
 *
 * Usage:
 * ```typescript
 * const scanner = container.resolve<IOutputRail>('IOutputRail');
 * const result = scanner.scan(llmOutput, { sanitize: true });
 * if (!result.passed) {
 *   logger.warn('Output rail violation', {
 *     violations: result.violationCount,
 *     maxSeverity: result.maxSeverity,
 *   });
 *   // Use result.sanitizedOutput instead of raw output
 * }
 * ```
 */
export interface IOutputRail {
  /**
   * Scan LLM output for policy violations.
   *
   * Applies Unicode normalization, then matches against the full
   * output violation pattern registry. Returns all violations found.
   *
   * @param output - Raw LLM-generated output to scan
   * @param options - Scan configuration (sanitize, fingerprints, etc.)
   * @returns Scan result with violations and timing
   */
  scan(output: string, options?: OutputRailScanOptions): OutputRailScanResult;

  /**
   * Quick check: does the output contain any critical-severity violations?
   *
   * Shortcut for `scan(output).violations.some(v => v.severity === 'critical')`.
   * More efficient — stops on first critical match.
   *
   * @param output - Raw LLM-generated output to scan
   * @returns true if critical violations found, false otherwise
   */
  hasCriticalViolations(output: string): boolean;
}
