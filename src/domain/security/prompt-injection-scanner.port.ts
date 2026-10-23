/**
 * Prompt Injection Scanner — Domain port for detecting and neutralizing
 * prompt injection attacks in external / untrusted content.
 *
 * Complements IContentBoundaryWrapper (boundary isolation) with
 * **detection + sanitization** capabilities:
 *  - Pattern-based suspicious content detection (12 heuristic regexes)
 *  - Unicode homoglyph folding (angle bracket variants + fullwidth ASCII)
 *  - Marker spoofing prevention
 *
 * @layer Domain (Security)
 * @phase 16A — Prompt Injection Detection (OpenClaw extraction)
 * @donor external/openclaw/src/security/external-content.ts (233L)
 * @owasp LLM01 (Prompt Injection) — Layer 1: detection + sanitization
 * @see IContentBoundaryWrapper for Layer 2 (boundary isolation)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Classification of external content source.
 * Used for metadata tagging in scan results and wrapped content.
 */
export type ExternalContentSource =
  | 'url'
  | 'file'
  | 'tool_output'
  | 'user_upload'
  | 'api_response'
  | 'plugin'
  | 'clipboard'
  | 'unknown';

/**
 * A single suspicious pattern match found in content.
 */
export interface SuspiciousMatch {
  /** Zero-based offset of the match in the (folded) content */
  readonly offset: number;
  /** Matched fragment (truncated to 120 chars) */
  readonly fragment: string;
  /** Pattern label describing the attack vector */
  readonly patternLabel: string;
}

/**
 * Result of scanning content for prompt injection indicators.
 */
export interface PromptInjectionScanResult {
  /** Whether any suspicious patterns were detected */
  readonly hasSuspiciousContent: boolean;
  /** Number of distinct matches */
  readonly matchCount: number;
  /** Individual matches with offset + fragment + label */
  readonly matches: readonly SuspiciousMatch[];
  /** Scan duration in milliseconds */
  readonly scanDurationMs: number;
  /**
   * Confidence score 0.0–1.0, where 1.0 = certain injection.
   *
   * Computed from: number of matches × pattern weight.
   * Enables threshold calibration and grey-zone logging.
   *
   * @see NeMo Guardrails v0.20 — probabilistic scoring
   * @see OpenAI Moderation API v2 — confidence-based classification
   */
  readonly confidence: number;
  /**
   * Risk tier derived from confidence:
   * - 'low'    (< 0.3): likely benign
   * - 'medium' (0.3–0.7): grey zone — log for manual audit
   * - 'high'   (> 0.7): likely injection
   */
  readonly tier: 'low' | 'medium' | 'high';
  /**
   * Number of distinct pattern categories matched.
   * Categories: injection, jailbreak, extraction, obfuscation, etc.
   */
  readonly categoryCount: number;
}

/**
 * Options for wrapping external content with injection-safe boundaries.
 */
export interface WrapExternalContentOptions {
  /** Source classification */
  source: ExternalContentSource;
  /** Optional human-readable label (e.g. URL, filename) */
  label?: string;
  /** Maximum content length before truncation */
  maxLength?: number;
}

// ─── Port Interface ──────────────────────────────────────────────────────────

/**
 * Domain contract for prompt injection scanning.
 *
 * Implementations MUST:
 * 1. Fold Unicode homoglyphs before matching (angle brackets, fullwidth ASCII)
 * 2. Use ReDoS-safe regex patterns (via SafeRegexCompiler or pre-verified)
 * 3. Prevent marker spoofing (strip existing boundary markers from content)
 * 4. Return all matches — never short-circuit on first hit
 *
 * Usage:
 * ```typescript
 * const scanner = container.resolve<IPromptInjectionScanner>('IPromptInjectionScanner');
 * const result = scanner.detectSuspiciousPatterns(untrustedContent);
 * if (result.hasSuspiciousContent) {
 *   logger.warn('Prompt injection attempt detected', { matches: result.matchCount });
 * }
 * const safePrompt = scanner.buildSafeExternalPrompt(content, { source: 'url', label: url });
 * ```
 */
export interface IPromptInjectionScanner {
  /**
   * Scan content for suspicious prompt injection patterns.
   *
   * Applies Unicode homoglyph folding, then matches against
   * the full pattern registry. Returns all matches found.
   *
   * @param content - Raw untrusted content to scan
   * @returns Scan result with matches and timing
   */
  detectSuspiciousPatterns(content: string): PromptInjectionScanResult;

  /**
   * Build a safe prompt string from external content.
   *
   * Delegates boundary wrapping to IContentBoundaryWrapper,
   * then prepends a security warning header.
   *
   * @param content - Raw untrusted content
   * @param options - Source classification and wrapping options
   * @returns Safe prompt string with boundary markers and warning
   */
  buildSafeExternalPrompt(
    content: string,
    options: WrapExternalContentOptions,
  ): string;

  /**
   * Fold Unicode homoglyphs to their ASCII equivalents.
   *
   * Normalizes angle bracket variants (14 Unicode forms)
   * and fullwidth ASCII characters (U+FF01–U+FF5E → U+0021–U+007E).
   *
   * Useful for pre-processing content before other security checks.
   *
   * @param content - Content with potential Unicode tricks
   * @returns Content with homoglyphs replaced by ASCII equivalents
   */
  foldUnicodeHomoglyphs(content: string): string;
}
