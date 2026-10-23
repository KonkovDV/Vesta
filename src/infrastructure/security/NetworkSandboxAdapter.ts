/**
 * NetworkSandboxAdapter — Infrastructure adapter for T31 Sandbox Isolation.
 *
 * In-memory allowlist-based network egress control. Evaluates outbound
 * requests against registered rules using hostname glob matching.
 * Default-deny policy for security-first approach.
 *
 * @layer Infrastructure (Security)
 * @pattern T31 Sandbox Isolation (Wave 5, Horizon 4-5)
 * @see src/domain/security/INetworkSandbox.ts — domain port
 * @owasp Agentic Top 10 2026: Tool Misuse — restrict network scope
 */

import type {
  INetworkSandbox,
  EgressDecision,
  NetworkProtocol,
  EgressRule,
  EgressEvaluation,
  EgressPolicy,
} from '../../domain/security/INetworkSandbox';

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Simple glob matcher for hostname patterns:
 * - `*` matches any sequence of chars
 * - `?` matches single char
 * - `*.example.com` matches `api.example.com`
 */
function globMatch(pattern: string, text: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(text);
}

/** Extract hostname from a URL string. */
function extractHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    // Fallback: attempt to extract hostname manually
    const match = url.match(/^(?:\w+:\/\/)?([^/:]+)/);
    return match?.[1] ?? url;
  }
}

/** Detect protocol from a URL string. */
function detectProtocol(url: string): NetworkProtocol {
  const lower = url.toLowerCase();
  if (lower.startsWith('wss://')) return 'wss';
  if (lower.startsWith('ws://')) return 'ws';
  if (lower.startsWith('https://')) return 'https';
  if (lower.startsWith('http://')) return 'http';
  return 'https'; // default to https
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Adapter ─────────────────────────────────────────────────────

export class NetworkSandboxAdapter implements INetworkSandbox {
  private readonly rules: EgressRule[] = [];
  private defaultDecision: EgressDecision = 'deny';
  private readonly logger?: MinimalLogger;

  constructor(logger?: MinimalLogger) {
    this.logger = logger;
  }

  evaluateEgress(url: string, agentId: string): EgressEvaluation {
    const hostname = extractHostname(url);
    const protocol = detectProtocol(url);

    // Find first matching rule
    const matchedRule = this.rules.find(rule => {
      // Check agent scope
      if (rule.agentScope && rule.agentScope !== agentId) return false;
      // Check protocol
      if (!rule.protocols.includes(protocol)) return false;
      // Check hostname pattern
      return globMatch(rule.pattern, hostname);
    });

    const decision = matchedRule?.decision ?? this.defaultDecision;

    if (decision === 'deny') {
      this.logger?.warn('Network egress denied', { url, hostname, protocol, agentId });
    } else {
      this.logger?.info('Network egress evaluated', {
        url, hostname, protocol, agentId, decision,
        matchedPattern: matchedRule?.pattern,
      });
    }

    return {
      url,
      hostname,
      protocol,
      agentId,
      decision,
      matchedRule,
      evaluatedAt: nowISO(),
    };
  }

  registerAllowRule(rule: EgressRule): void {
    this.rules.push(rule);
    this.logger?.info('Egress rule registered', {
      pattern: rule.pattern,
      protocols: rule.protocols,
      decision: rule.decision,
    });
  }

  removeRule(pattern: string): boolean {
    const idx = this.rules.findIndex(r => r.pattern === pattern);
    if (idx >= 0) {
      this.rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  getEgressPolicy(agentId?: string): EgressPolicy {
    const applicableRules = agentId
      ? this.rules.filter(r => !r.agentScope || r.agentScope === agentId)
      : [...this.rules];

    return {
      defaultDecision: this.defaultDecision,
      rules: applicableRules,
      agentId,
    };
  }

  setDefaultDecision(decision: EgressDecision): void {
    this.defaultDecision = decision;
  }
}
