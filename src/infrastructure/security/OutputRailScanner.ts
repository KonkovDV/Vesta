/**
 * OutputRailScanner — Infrastructure implementation of IOutputRail.
 *
 * Detects policy violations in LLM-generated output through pattern matching,
 * Unicode normalization, and optional sanitization (redaction).
 *
 * Port: {@link IOutputRail} (src/domain/security/output-rail.port.ts)
 *
 * Architecture:
 *  - 11 output violation pattern categories
 *  - Unicode normalization (fullwidth ASCII + invisible chars)
 *  - Optional sanitization: redacts matched fragments with [REDACTED]
 *  - Custom system prompt fingerprints for project-specific leak detection
 *  - Feature-flag gated via `enableOutputRail` (returns pass-through when disabled)
 *
 * @layer Infrastructure (Security)
 * @phase 0B — Output Rail Scanner (NeMo Layer 5)
 * @owasp LLM07 (System Prompt Leakage), LLM02 (Sensitive Information Disclosure)
 * @see PromptInjectionScanner for Layer 1 (input-side)
 */

import type {
  IOutputRail,
  OutputRailScanResult,
  OutputRailScanOptions,
  OutputRailSeverity,
  OutputViolation,
  OutputViolationCategory,
} from '../../domain/security/output-rail.port';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Redaction placeholder for sanitized output */
const REDACTION_MARKER = '[REDACTED]';

/** Default maximum output length before flagging */
const DEFAULT_MAX_OUTPUT_LENGTH = 50_000;

/** Severity ranking for comparison */
const SEVERITY_RANK: Record<OutputRailSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ─── Output Violation Pattern Registry ───────────────────────────────────────

interface OutputPattern {
  readonly label: string;
  readonly category: OutputViolationCategory;
  readonly severity: OutputRailSeverity;
  readonly description: string;
  readonly pattern: RegExp;
}

/**
 * 11 heuristic patterns for detecting output policy violations.
 *
 * Each pattern is:
 *  - Case-insensitive
 *  - Pre-verified for ReDoS safety (no nested quantifiers)
 *  - Applied after Unicode normalization
 */
const OUTPUT_PATTERNS: readonly OutputPattern[] = [
  // ── System Prompt Leakage (OWASP LLM07) ───────────────────────
  {
    label: 'system_prompt_leak_header',
    category: 'system_prompt_leak',
    severity: 'critical',
    description: 'Output contains system prompt / instruction block markers',
    pattern: /(?:system\s+prompt|system\s+instruction|initial\s+instruction|you\s+are\s+an?\s+AI\s+(?:assistant|model|system))\s*[:=]/i,
  },
  {
    label: 'system_prompt_leak_verbatim',
    category: 'system_prompt_leak',
    severity: 'critical',
    description: 'Output echoes verbatim instruction-like content',
    pattern: /(?:my\s+(?:system\s+)?instructions?\s+(?:are|say|tell\s+me)\b|here\s+(?:are|is)\s+my\s+(?:system\s+)?prompt)/i,
  },

  // ── PII / Credential Exposure (LLM02) ─────────────────────────
  {
    label: 'email_exposure',
    category: 'pii_exposure',
    severity: 'medium',
    description: 'Output contains email address pattern (excludes safe/example domains)',
    // AUDIT-V6 G12: Negative lookahead excludes known safe domains to reduce false positives.
    // Safe domains: example.com/org/net (RFC 2606), test.com, localhost, placeholder patterns.
    pattern: /\b[A-Za-z0-9._%+-]+@(?!(?:example\.(?:com|org|net)|test\.com|localhost|placeholder\.com|noreply\.[\w.]+)\b)[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    label: 'api_key_exposure',
    category: 'credential_leak',
    severity: 'critical',
    description: 'Output contains API key / secret pattern',
    pattern: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|bearer\s+token|authorization:\s*bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-/.]{20,}/i,
  },
  {
    label: 'password_exposure',
    category: 'credential_leak',
    severity: 'critical',
    description: 'Output contains password / secret assignment',
    pattern: /(?:password|passwd|pwd|secret)\s*[:=]\s*["']?[^\s"']{8,}/i,
  },

  // ── Hallucinated Actions ───────────────────────────────────────
  {
    label: 'hallucinated_tool_call',
    category: 'hallucinated_action',
    severity: 'high',
    description: 'Output contains fabricated tool invocation syntax',
    pattern: /(?:<tool_call>|<function_call>|\{"\s*(?:tool|function)\s*":\s*"\w+"|Action:\s*\w+\[)/i,
  },

  // ── Harmful / Toxic Content ────────────────────────────────────
  {
    label: 'harmful_instruction',
    category: 'harmful_content',
    severity: 'high',
    description: 'Output provides step-by-step harmful instructions',
    pattern: /(?:step\s*(?:1|one)\s*:\s*(?:obtain|acquire|steal|hack|bypass|disable))/i,
  },

  // ── Excessive Disclosure ───────────────────────────────────────
  {
    label: 'env_var_dump',
    category: 'excessive_disclosure',
    severity: 'high',
    description: 'Output dumps environment variable assignments',
    pattern: /(?:DATABASE_URL|REDIS_URL|SECRET_KEY|JWT_SECRET|DB_PASSWORD|AWS_SECRET)\s*=\s*\S+/i,
  },

  // ── Unicode Smuggling ─────────────────────────────────────────
  {
    label: 'invisible_unicode_output',
    category: 'unicode_smuggling',
    severity: 'medium',
    description: 'Output contains invisible Unicode characters (potential smuggling)',
    pattern: /[\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/,
  },

  // ── Boundary / Context Leakage ─────────────────────────────────
  {
    label: 'boundary_marker_leak',
    category: 'boundary_leak',
    severity: 'high',
    description: 'Output leaks internal boundary markers',
    pattern: /<\/?external-content\b[^>]*>|<\/?(?:system|user|assistant)\s*>/i,
  },

  // ── Instruction Echo ──────────────────────────────────────────
  {
    label: 'instruction_echo',
    category: 'instruction_echo',
    severity: 'medium',
    description: 'Output echoes "do not" / "never" instruction constraints',
    pattern: /(?:I\s+(?:was|am)\s+(?:instructed|told|programmed)\s+(?:to|not\s+to)|my\s+(?:rules?|guidelines?|constraints?)\s+(?:say|require|prevent|forbid))/i,
  },
] as const;

// ─── Unicode Normalization ───────────────────────────────────────────────────

/** Fullwidth ASCII range: U+FF01–U+FF5E → U+0021–U+007E. */
const FULLWIDTH_RE = /[\uFF01-\uFF5E]/g;

/**
 * Normalize Unicode tricks that could bypass pattern matching.
 * - Folds fullwidth ASCII to standard ASCII
 * - Preserves invisible chars (they are explicitly detected by patterns)
 */
function normalizeUnicode(text: string): string {
  return text.replace(FULLWIDTH_RE, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
  );
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class OutputRailScanner implements IOutputRail {
  constructor(
    private readonly logger?: {
      info?(msg: string, ctx?: Record<string, unknown>): void;
      warn?(msg: string, ctx?: Record<string, unknown>): void;
    },
  ) {}

  /**
   * Scan LLM output for policy violations.
   */
  scan(output: string, options?: OutputRailScanOptions): OutputRailScanResult {
    const start = Date.now();
    const minSeverityRank = SEVERITY_RANK[options?.minSeverity ?? 'low'];
    const maxOutputLength = options?.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH;
    const violations: OutputViolation[] = [];
    // Parallel array: actual match length for each violation (fragment may be truncated to 120)
    const matchLengths: number[] = [];

    // Normalize Unicode before matching
    const normalized = normalizeUnicode(output);

    // ── Check excessive output length ────────────────────────────
    if (normalized.length > maxOutputLength) {
      violations.push({
        category: 'excessive_disclosure',
        description: `Output length (${normalized.length}) exceeds maximum (${maxOutputLength})`,
        severity: 'medium',
        offset: maxOutputLength,
        matchedFragment: `[output truncated at ${maxOutputLength} chars]`,
        patternLabel: 'excessive_output_length',
      });
      matchLengths.push(0); // Not a regex match — no real fragment to redact by offset
    }

    // ── Run built-in pattern matching ────────────────────────────
    for (const pat of OUTPUT_PATTERNS) {
      if (SEVERITY_RANK[pat.severity] < minSeverityRank) continue;

      // Use global flag for finding all occurrences
      const globalRe = new RegExp(pat.pattern.source, pat.pattern.flags.includes('g') ? pat.pattern.flags : pat.pattern.flags + 'g');

      let match: RegExpExecArray | null;
      while ((match = globalRe.exec(normalized)) !== null) {
        const actualLength = match[0].length;
        const fragment = actualLength > 120 ? match[0].slice(0, 120) : match[0];
        violations.push({
          category: pat.category,
          description: pat.description,
          severity: pat.severity,
          offset: match.index,
          matchedFragment: fragment,
          patternLabel: pat.label,
        });
        matchLengths.push(actualLength);
      }
    }

    // ── Custom system prompt fingerprints ─────────────────────────
    if (options?.systemPromptFingerprints) {
      for (const fingerprint of options.systemPromptFingerprints) {
        const escaped = fingerprint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped, 'gi');
        let match: RegExpExecArray | null;
        while ((match = re.exec(normalized)) !== null) {
          const actualLength = match[0].length;
          const fragment = actualLength > 120 ? match[0].slice(0, 120) : match[0];
          violations.push({
            category: 'system_prompt_leak',
            description: `Output contains system prompt fingerprint: "${fingerprint}"`,
            severity: 'critical',
            offset: match.index,
            matchedFragment: fragment,
            patternLabel: 'custom_fingerprint',
          });
          matchLengths.push(actualLength);
        }
      }
    }

    // ── Compute max severity ─────────────────────────────────────
    let maxSeverity: OutputRailSeverity | null = null;
    for (const v of violations) {
      if (maxSeverity === null || SEVERITY_RANK[v.severity] > SEVERITY_RANK[maxSeverity]) {
        maxSeverity = v.severity;
      }
    }

    // ── Sanitize output if requested ─────────────────────────────
    let sanitizedOutput: string | undefined;
    if (options?.sanitize && violations.length > 0) {
      sanitizedOutput = this.sanitize(output, violations, matchLengths);
    }

    const scanDurationMs = Date.now() - start;
    const passed = violations.length === 0;

    if (!passed) {
      this.logger?.warn?.('output_rail.violations_detected', {
        violationCount: violations.length,
        maxSeverity,
        categories: [...new Set(violations.map((v) => v.category))],
        scanDurationMs,
      });
    }

    return {
      passed,
      maxSeverity,
      violationCount: violations.length,
      violations,
      sanitizedOutput,
      scanDurationMs,
    };
  }

  /**
   * Quick check for critical violations (short-circuits on first match).
   */
  hasCriticalViolations(output: string): boolean {
    const normalized = normalizeUnicode(output);

    for (const pat of OUTPUT_PATTERNS) {
      if (pat.severity !== 'critical') continue;
      if (pat.pattern.test(normalized)) return true;
    }

    return false;
  }

  /**
   * Create a no-op scanner (for feature flag disabled state).
   * Always returns passed=true with no violations.
   */
  static createNoop(): IOutputRail {
    return {
      scan(_output: string, _options?: OutputRailScanOptions): OutputRailScanResult {
        return {
          passed: true,
          maxSeverity: null,
          violationCount: 0,
          violations: [],
          scanDurationMs: 0,
        };
      },
      hasCriticalViolations(_output: string): boolean {
        return false;
      },
    };
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Sanitize output by redacting violation fragments.
   * Uses actual match lengths (not truncated fragment lengths) for accurate redaction.
   * Works on original (non-normalized) output using offset positions
   * from normalized scan. Since normalization replaces fullwidth chars 1:1,
   * offsets are preserved.
   */
  private sanitize(
    originalOutput: string,
    violations: readonly OutputViolation[],
    matchLengths: readonly number[],
  ): string {
    // Build (offset, length) pairs indexed to violations, then sort descending by offset
    const indexed = violations.map((v, i) => ({
      offset: v.offset,
      length: matchLengths[i] ?? v.matchedFragment.length,
    }));
    indexed.sort((a, b) => b.offset - a.offset);

    let result = originalOutput;
    for (const { offset, length } of indexed) {
      if (length <= 0) continue; // Skip non-regex violations (e.g. excessive_output_length)
      const end = offset + length;
      if (offset >= 0 && end <= result.length) {
        result =
          result.slice(0, offset) +
          REDACTION_MARKER +
          result.slice(end);
      }
    }

    return result;
  }
}
