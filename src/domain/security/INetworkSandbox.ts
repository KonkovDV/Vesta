/**
 * INetworkSandbox — Domain port for network egress control.
 *
 * T31 Sandbox Isolation: Enforces network isolation during autonomous
 * agent execution cycles. Companion to IPathBoundaryEnforcer which
 * handles file system boundaries — this port handles network egress
 * (DNS, IP, protocol) boundaries.
 *
 * SOTA 2026: Sandbox isolation prevents autonomous agents from making
 * unrestricted network requests. Allowlist-based egress control with
 * hostname glob patterns, protocol restrictions, and per-agent policies.
 *
 * @layer Domain (Security)
 * @pattern T31 Sandbox Isolation (Wave 5, Horizon 4-5)
 * @see src/domain/security/path-boundary-enforcer.port.ts — file system companion
 * @see src/core/events/network-sandbox.schemas.ts — Zod validation schemas
 * @owasp Agentic Top 10 2026: Tool Misuse — restrict network scope
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Network egress decision.
 */
export type EgressDecision = 'allow' | 'deny' | 'log-only';

/**
 * Supported network protocols for egress rules.
 */
export type NetworkProtocol = 'http' | 'https' | 'ws' | 'wss' | 'tcp' | 'udp';

/**
 * An egress rule defining access policy for a network destination.
 */
export interface EgressRule {
  /** Hostname glob pattern: "*.openai.com", "api.anthropic.com" */
  readonly pattern: string;
  /** Allowed protocols */
  readonly protocols: readonly NetworkProtocol[];
  /** Decision when rule matches */
  readonly decision: EgressDecision;
  /** Restrict rule to a specific agent (undefined = all agents) */
  readonly agentScope?: string;
  /** Human-readable reason for this rule */
  readonly reason?: string;
}

/**
 * Result of evaluating a network egress request.
 */
export interface EgressEvaluation {
  /** The URL that was evaluated */
  readonly url: string;
  /** Extracted hostname */
  readonly hostname: string;
  /** Detected protocol */
  readonly protocol: NetworkProtocol;
  /** Agent that requested egress */
  readonly agentId: string;
  /** Egress decision */
  readonly decision: EgressDecision;
  /** Rule that matched (if any) */
  readonly matchedRule?: EgressRule;
  /** ISO timestamp of evaluation */
  readonly evaluatedAt: string;
}

/**
 * Complete egress policy for an agent.
 */
export interface EgressPolicy {
  /** Default decision when no rule matches */
  readonly defaultDecision: EgressDecision;
  /** Ordered list of egress rules */
  readonly rules: readonly EgressRule[];
  /** Agent this policy applies to (undefined = global) */
  readonly agentId?: string;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * INetworkSandbox — enforces network egress control for autonomous agents.
 *
 * Evaluates outbound network requests against registered allowlist rules.
 * Default-deny: agents cannot make network calls unless explicitly allowed.
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface INetworkSandbox {
  /**
   * Evaluate whether an agent can make an outbound network request.
   *
   * @param url - Target URL
   * @param agentId - Agent making the request
   * @returns Egress evaluation with decision and matched rule
   */
  evaluateEgress(url: string, agentId: string): EgressEvaluation;

  /**
   * Register a new egress allow/deny rule.
   *
   * @param rule - Egress rule to register
   */
  registerAllowRule(rule: EgressRule): void;

  /**
   * Remove an egress rule by hostname pattern.
   *
   * @param pattern - Hostname pattern to remove
   * @returns true if a rule was removed
   */
  removeRule(pattern: string): boolean;

  /**
   * Get the complete egress policy for an agent.
   *
   * @param agentId - Agent to query (undefined = global policy)
   * @returns Egress policy including default decision and all applicable rules
   */
  getEgressPolicy(agentId?: string): EgressPolicy;

  /**
   * Set the default egress decision when no rule matches.
   *
   * @param decision - Default decision (typically 'deny' for security)
   */
  setDefaultDecision(decision: EgressDecision): void;
}
