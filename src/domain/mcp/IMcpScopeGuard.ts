/**
 * IMcpScopeGuard — Domain port for MCP server access control.
 *
 * T16 MCP Scope Model: Enforces project/user/subagent scope levels
 * for MCP tool access. Each scope level restricts which MCP tools
 * an agent can invoke, supporting glob patterns for flexible rules.
 *
 * SOTA 2026: MCP scope isolation prevents subagent privilege escalation —
 * a subagent spawned for read-only analysis should not access
 * mcp__extraction__donor_clone or destructive tools.
 *
 * Scope hierarchy (outer → inner): project > user > subagent
 * - project: full access to all MCP tools
 * - user: restricted to non-destructive tools and read-only operations
 * - subagent: minimal access, only tools explicitly allowed
 *
 * @layer Domain (MCP)
 * @pattern T16 MCP Scope Model (Wave 5, Horizon 4-5)
 * @see src/domain/mcp/IMcpServer.ts — MCP server contract
 * @see src/domain/mcp/IMcpBridge.ts — MCP-A2A bridge
 * @see src/core/events/mcp-scope-guard.schemas.ts — Zod validation schemas
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * MCP access scope levels (outer → inner restriction).
 */
export type McpScopeLevel = 'project' | 'user' | 'subagent';

/**
 * Access decision for an MCP tool invocation.
 */
export type McpAccessDecision = 'allow' | 'deny' | 'escalate';

/**
 * A rule mapping tool patterns to access decisions at a scope level.
 */
export interface McpScopeRule {
  /** Glob pattern matching tool names: "mcp__context__*", "mcp__extraction__donor_*" */
  readonly pattern: string;
  /** Scope level this rule applies to */
  readonly scopeLevel: McpScopeLevel;
  /** Access decision when rule matches */
  readonly decision: McpAccessDecision;
  /** Human-readable reason for this rule */
  readonly reason?: string;
}

/**
 * Result of evaluating an MCP tool access request.
 */
export interface McpAccessEvaluation {
  /** Tool name that was evaluated */
  readonly toolName: string;
  /** Scope level of the requesting agent */
  readonly scopeLevel: McpScopeLevel;
  /** Agent that requested access */
  readonly agentId: string;
  /** Access decision */
  readonly decision: McpAccessDecision;
  /** Rule that matched (if any) */
  readonly matchedRule?: McpScopeRule;
  /** ISO timestamp of evaluation */
  readonly evaluatedAt: string;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * IMcpScopeGuard — enforces scope-based access control for MCP tools.
 *
 * Evaluates tool access requests against registered scope rules.
 * Rules use glob patterns for flexible matching.
 */
export interface IMcpScopeGuard {
  /**
   * Evaluate whether an agent can access an MCP tool at a given scope level.
   *
   * @param toolName - Fully qualified MCP tool name
   * @param scopeLevel - Scope level of the requesting agent
   * @param agentId - Agent requesting access
   * @returns Access evaluation with decision and matched rule
   */
  evaluateAccess(
    toolName: string,
    scopeLevel: McpScopeLevel,
    agentId: string,
  ): McpAccessEvaluation;

  /**
   * Register a new scope rule.
   *
   * @param rule - Scope rule to register
   */
  registerScopeRule(rule: McpScopeRule): void;

  /**
   * Remove a scope rule by pattern and scope level.
   *
   * @param pattern - Tool name pattern to match
   * @param scopeLevel - Scope level of the rule
   * @returns true if a rule was removed
   */
  removeScopeRule(pattern: string, scopeLevel: McpScopeLevel): boolean;

  /**
   * Get all scope rules, optionally filtered by tool name pattern.
   *
   * @param toolName - Optional tool name to filter rules (exact match, not glob)
   * @returns Array of matching scope rules
   */
  getScopeRules(toolName?: string): McpScopeRule[];

  /**
   * Get the default access decision for a scope level
   * when no explicit rule matches.
   *
   * @param scopeLevel - Scope level to query
   * @returns Default decision for that scope level
   */
  getDefaultDecision(scopeLevel: McpScopeLevel): McpAccessDecision;
}
