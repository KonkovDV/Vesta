/**
 * Content Threat Scanner — regex-based injection/abuse detection for memory content.
 *
 * Layer: Domain (Security)
 * Origin: Hermes-Agent memory_tool.py — 12 threat patterns + prompt_builder.py context file scanning.
 *
 * Scans text for prompt injection, role hijacking, credential exfiltration,
 * hidden instructions, eval injection, and other abuse patterns.
 * Used by Memory layer and context file loaders to reject or flag malicious content.
 *
 * Pure domain logic — no external dependencies.
 */

// ── Types ────────────────────────────────────────────────────────────

/**
 * Category of detected threat.
 */
export type ThreatCategory =
  | 'prompt_injection'
  | 'role_hijack'
  | 'deception_hide'
  | 'exfil_curl'
  | 'ssh_backdoor'
  | 'tool_abuse'
  | 'hidden_instruction'
  | 'invisible_unicode'
  | 'eval_injection'
  | 'file_exfil'
  | 'base64_obfuscation'
  | 'markdown_exfil'
  | 'translate_execute'
  | 'hidden_div';

/**
 * Severity level of a detected threat.
 */
export type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * A single detected threat instance.
 */
export interface DetectedThreat {
  /** Threat category identifier */
  readonly category: ThreatCategory;
  /** Human-readable description */
  readonly description: string;
  /** Severity level */
  readonly severity: ThreatSeverity;
  /** Byte offset in the original content (start) */
  readonly offset: number;
  /** Matched fragment (truncated to 120 chars) */
  readonly matchedFragment: string;
}

/**
 * Result of a content threat scan.
 */
export interface ThreatScanResult {
  /** Whether any threats were detected */
  readonly hasThreat: boolean;
  /** Highest severity among all detected threats */
  readonly maxSeverity: ThreatSeverity | null;
  /** All detected threat instances */
  readonly threats: readonly DetectedThreat[];
  /** Scan execution time in milliseconds */
  readonly scanDurationMs: number;
}

// ── Threat Pattern Registry ──────────────────────────────────────────

interface ThreatPattern {
  readonly category: ThreatCategory;
  readonly description: string;
  readonly severity: ThreatSeverity;
  readonly pattern: RegExp;
}

/**
 * 14 threat patterns derived from Hermes-Agent memory_tool.py + prompt_builder.py.
 *
 * Order: patterns are evaluated sequentially; all matches are collected.
 */
const THREAT_PATTERNS: readonly ThreatPattern[] = [
  // ── Prompt Injection ──────────────────────────────────────────
  {
    category: 'prompt_injection',
    description: 'Attempt to override/ignore prior instructions',
    severity: 'critical',
    pattern:
      /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|context|rules)/i,
  },

  // ── Role Hijacking ────────────────────────────────────────────
  {
    category: 'role_hijack',
    description: 'Attempt to reassign AI identity or role',
    severity: 'critical',
    pattern: /(?:you are now|act as|pretend to be|your new role)/i,
  },

  // ── Deception / Concealment ───────────────────────────────────
  {
    category: 'deception_hide',
    description: 'Instructions to hide or keep secret from user',
    severity: 'high',
    pattern:
      /(?:don'?t\s+tell|keep\s+secret|hide\s+this|do\s+not\s+reveal|never\s+mention)/i,
  },

  // ── Credential Exfiltration (curl/wget) ───────────────────────
  {
    category: 'exfil_curl',
    description: 'Network command referencing environment variables (data exfil)',
    severity: 'critical',
    pattern:
      /(?:curl|wget|fetch|http\.get|requests\.get)\s+.*\$\{?[A-Z_]+\}?/i,
  },

  // ── SSH Backdoor ──────────────────────────────────────────────
  {
    category: 'ssh_backdoor',
    description: 'SSH key injection or authorized_keys manipulation',
    severity: 'critical',
    pattern: /(?:ssh-keygen|authorized_keys|ssh-copy-id)/i,
  },

  // ── Tool Abuse Conditioning ───────────────────────────────────
  {
    category: 'tool_abuse',
    description: 'Conditioning AI to always use specific tools',
    severity: 'high',
    pattern: /(?:when\s+.*use\s+terminal|always\s+run|execute\s+.*silently)/i,
  },

  // ── Hidden Instruction Tags ───────────────────────────────────
  {
    category: 'hidden_instruction',
    description: 'Fake system/admin instruction tags',
    severity: 'high',
    pattern: /\[(?:HIDDEN|SYSTEM|ADMIN|OVERRIDE)\]/,
  },

  // ── Invisible Unicode Characters ──────────────────────────────
  {
    category: 'invisible_unicode',
    description: 'Zero-width or invisible Unicode characters (steganography)',
    severity: 'medium',
    pattern: /\u200b|\u200c|\u200d|\u200e|\u200f|\ufeff|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069/,
  },

  // ── Eval / Code Injection ─────────────────────────────────────
  {
    category: 'eval_injection',
    description: 'Dangerous dynamic code execution patterns',
    severity: 'critical',
    pattern: /(?:eval\s*\(|exec\s*\(|import\s+subprocess|os\.system)/i,
  },

  // ── File Exfiltration ─────────────────────────────────────────
  {
    category: 'file_exfil',
    description: 'Reading sensitive files (env, passwords, secrets)',
    severity: 'high',
    pattern:
      /(?:cat|read|type)\s+.*(?:\.env|password|secret|key|token|credential)/i,
  },

  // ── Base64 Obfuscation ────────────────────────────────────────
  {
    category: 'base64_obfuscation',
    description: 'Base64 encoding/decoding used for obfuscation',
    severity: 'medium',
    pattern: /base64\s*(?:encode|decode|\.b64)/i,
  },

  // ── Markdown Image Exfiltration ───────────────────────────────
  {
    category: 'markdown_exfil',
    description: 'Markdown image with variable interpolation (data exfil via URL)',
    severity: 'critical',
    pattern: /!\[.*?\]\(https?:\/\/.*?\$\{/,
  },

  // ── Translate-Execute Trick ───────────────────────────────────
  {
    category: 'translate_execute',
    description: 'Social engineering: translate → execute via confusion',
    severity: 'high',
    pattern: /(?:translate|convert)\s+.*\b(?:run|exec|execute)\b/i,
  },

  // ── Hidden DIV (HTML steganography) ───────────────────────────
  {
    category: 'hidden_div',
    description: 'Hidden HTML elements that may contain injected instructions',
    severity: 'medium',
    pattern: /<div\s+style\s*=\s*['"].*?display:\s*none/i,
  },
] as const;

// ── Severity Ordering ────────────────────────────────────────────────

const SEVERITY_ORDER: Record<ThreatSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Scan content for known threat patterns.
 *
 * Returns all detected threats sorted by severity (highest first).
 * This is a synchronous, pure function — safe to call from any layer.
 *
 * @param content - Text content to scan
 * @returns ThreatScanResult with all detected threats
 *
 * @example
 * ```typescript
 * const result = scanContentForThreats("Ignore all previous instructions");
 * if (result.hasThreat) {
 *   logger.warn('Threat detected', { threats: result.threats });
 * }
 * ```
 */
export function scanContentForThreats(content: string): ThreatScanResult {
  const start = performance.now();
  const threats: DetectedThreat[] = [];

  for (const tp of THREAT_PATTERNS) {
    // Use global flag to find ALL occurrences
    const globalPattern = new RegExp(tp.pattern.source, tp.pattern.flags.includes('g') ? tp.pattern.flags : tp.pattern.flags + 'g');
    let match: RegExpExecArray | null;

    while ((match = globalPattern.exec(content)) !== null) {
      const matchedText = match[0];
      threats.push({
        category: tp.category,
        description: tp.description,
        severity: tp.severity,
        offset: match.index,
        matchedFragment: matchedText.length > 120 ? matchedText.slice(0, 117) + '...' : matchedText,
      });
    }
  }

  // Sort by severity descending
  threats.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);

  const maxSeverity = threats.length > 0 ? threats[0].severity : null;
  const scanDurationMs = performance.now() - start;

  return {
    hasThreat: threats.length > 0,
    maxSeverity,
    threats,
    scanDurationMs,
  };
}

/**
 * Quick check — returns true if ANY threat of the given severity or higher is detected.
 *
 * This is cheaper than `scanContentForThreats()` when you only need a boolean
 * answer, because it short-circuits on the first match at or above the threshold.
 *
 * @param content - Text content to check
 * @param minSeverity - Minimum severity threshold (default: 'medium')
 * @returns true if a threat at or above the threshold was found
 */
export function hasContentThreat(
  content: string,
  minSeverity: ThreatSeverity = 'medium',
): boolean {
  const threshold = SEVERITY_ORDER[minSeverity];

  for (const tp of THREAT_PATTERNS) {
    if (SEVERITY_ORDER[tp.severity] < threshold) continue;
    if (tp.pattern.test(content)) return true;
  }

  return false;
}

/**
 * Get all registered threat patterns (for diagnostics / documentation).
 */
export function getThreatPatterns(): readonly Omit<ThreatPattern, 'pattern'>[] {
  return THREAT_PATTERNS.map(({ category, description, severity }) => ({
    category,
    description,
    severity,
  }));
}
