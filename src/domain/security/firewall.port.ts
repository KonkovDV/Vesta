/**
 * Cognitive Firewall — Domain port for request inspection.
 * Validates schema integrity, sanitizes XSS vectors, detects jailbreak patterns.
 *
 * @layer Domain (Security)
 * @phase 7 — Cognitive Firewall Service
 * @owasp LLM01 (Prompt Injection)
 * @see IPromptInjectionScanner for deeper prompt injection scanning
 */

/**
 * Result of firewall inspection — validated and sanitized request data.
 */
export interface FirewallInspectionResult {
  readonly [key: string]: unknown;
  readonly scenario: string;
  readonly sessionId?: string;
  readonly payload?: {
    readonly instruction: string;
    readonly context?: Record<string, unknown>;
  };
}

/**
 * Cognitive Firewall service interface.
 * Implementations validate schema, sanitize inputs, and check heuristics.
 */
export interface IFirewallService {
  /**
   * Inspects and sanitizes an incoming request payload.
   * @throws Error if schema validation fails or jailbreak heuristic triggered.
   */
  inspectRequest(payload: unknown): FirewallInspectionResult;

  /**
   * Validates a string for cognitive threats and sanitizes HTML.
   * @throws Error if jailbreak pattern detected.
   */
  sanitizeString(input: string): string;
}
