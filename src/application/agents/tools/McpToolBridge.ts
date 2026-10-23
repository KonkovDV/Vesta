/**
 * McpToolBridge — Adapter: wraps an MCP tool schema into IAgentTool.
 *
 * Bridges the Agent runtime (ToolRegistry) with the MCP Client infrastructure
 * (IMcpClientRegistry). Each discovered MCP tool becomes an IAgentTool instance.
 *
 * Best Practices (March 2026):
 *  - MCP 2025-06-18 spec: tool annotations, read-only hints
 *  - Output truncation delegated to McpClientRegistry (maxToolOutputChars)
 *  - Credential stripping delegated to McpClientRegistry (sanitizeError)
 *  - Tool name prefixing: mcp_{server}_{tool} (collision avoidance)
 *
 * Layer: Application (depends on Domain port only — no Infrastructure imports)
 * @see src/domain/ai/mcp-client-registry.port.ts — IMcpClientRegistry, McpToolSchema
 * @see src/domain/ai/IAgentTool.ts — IAgentTool contract
 */

import type { IAgentTool, ToolExecutionContext, ToolExecutionResult } from '../../../domain/ai/IAgentTool';
import type { IMcpClientRegistry, McpToolSchema } from '../../../domain/ai/mcp-client-registry.port';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { ICircuitBreaker, CircuitBreakerResult } from '../../../domain/external/ICircuitBreaker';
import type { IMcpScopeGuard, McpScopeLevel } from '../../../domain/mcp/IMcpScopeGuard';
import type { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';
import type { IUserApprovalInterceptor } from '../../../domain/security/IUserApprovalInterceptor';

type ToolArgumentBag = Record<string, unknown>;
type ContextRecord = Record<string, unknown>;

/**
 * Adapts a single MCP tool schema into IAgentTool interface.
 *
 * Lifecycle: created once per discovered MCP tool, cached in McpToolDiscoveryService.
 * Thread-safe: delegates to McpClientRegistry which handles rate limiting + reconnection.
 */
export class McpToolBridge implements IAgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolArgumentBag;

  /**
   * RBAC scopes required for this tool (from McpToolSchema).
   * When non-empty, execute() verifies that ToolExecutionContext grants them.
   * @since v2.9.0 — GAP-Rec-3 (Academic Audit)
   */
  readonly scopes: readonly string[];

  constructor(
    private readonly schema: McpToolSchema,
    private readonly registry: IMcpClientRegistry,
    private readonly logger?: ILogger,
    private readonly circuitBreaker?: ICircuitBreaker,
    private readonly scopeGuard?: IMcpScopeGuard,
    private readonly toolPolicy?: IToolExecutionPolicy,
    private readonly approvalInterceptor?: IUserApprovalInterceptor,
  ) {
    this.name = schema.name;               // already prefixed: mcp_{server}_{tool}
    this.description = schema.description;
    this.parameters = schema.parameters;
    this.scopes = schema.scopes ?? [];
  }

  /**
   * Execute the MCP tool via IMcpClientRegistry.callTool().
   *
   * Security: all args pass through ToolRegistry's policy + firewall BEFORE reaching this method.
   * Truncation / credential stripping: handled by McpClientRegistry infrastructure.
   */
  async execute(
    args: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const start = Date.now();
    const normalizedArgs = (args as ToolArgumentBag) ?? {};

    // ── GAP-Rec-3: RBAC scope check via IMcpScopeGuard ──────────────
    // FIX: SOTA-MCP-SCOPE — delegate scope evaluation to IMcpScopeGuard (T16)
    // instead of inline array filtering. Enables centralized rule management,
    // glob patterns, and scope-level defaults (project/user/subagent).
    if (this.scopeGuard) {
      const ctxRecord = context as ContextRecord | undefined;
      const agentId = (ctxRecord?.agentId as string) ?? 'unknown';
      const scopeLevel: McpScopeLevel = (ctxRecord?.scopeLevel as McpScopeLevel) ?? 'subagent';
      const evaluation = this.scopeGuard.evaluateAccess(this.name, scopeLevel, agentId);
      if (evaluation.decision === 'deny') {
        this.logger?.warn('MCP tool scope denied by IMcpScopeGuard', {
          tool: this.name,
          scopeLevel,
          agentId,
          rule: evaluation.matchedRule?.pattern,
          correlationId: context?.sessionId,
        });
        return {
          content: `MCP tool "${this.name}" denied: scope guard rejected access (level: ${scopeLevel}, agent: ${agentId})`,
          isError: true,
          metadata: { server: this.schema.serverName, originalTool: this.schema.originalName, elapsed: 0 },
        };
      }
      if (evaluation.decision === 'escalate') {
        this.logger?.warn('MCP tool scope escalation required', {
          tool: this.name,
          scopeLevel,
          agentId,
          correlationId: context?.sessionId,
        });
        return this.handleApprovalRequirement({
          args: normalizedArgs,
          context,
          reason: `Scope escalation required for level ${scopeLevel}`,
          scopeLevel,
          agentId,
          start,
        });
      }
    } else if (this.scopes.length > 0) {
      // Fallback: legacy inline scope check when IMcpScopeGuard is not available.
      // FIX: ACA-01 — enforce scope check even when context is absent.
      const ctxRecord = context as ContextRecord | undefined;
      const rawScopes = ctxRecord?.scopes;
      const granted: readonly string[] = Array.isArray(rawScopes) ? rawScopes as readonly string[] : [];
      const missing = this.scopes.filter(s => !granted.includes(s));
      if (missing.length > 0) {
        this.logger?.warn('MCP tool scope denied', {
          tool: this.name,
          missing,
          correlationId: context?.sessionId,
        });
        return {
          content: `MCP tool "${this.name}" denied: missing scopes [${missing.join(', ')}]`,
          isError: true,
          metadata: { server: this.schema.serverName, originalTool: this.schema.originalName, elapsed: 0 },
        };
      }
    }

    if (this.toolPolicy) {
      const policyResult = await this.toolPolicy.evaluate({
        toolName: this.name,
        arguments: normalizedArgs,
        agentId: typeof context?.agentId === 'string' ? context.agentId : undefined,
        userId: context?.userId,
        sessionId: context?.sessionId,
        traceId: typeof context?.traceId === 'string' ? context.traceId : undefined,
        scopeLevel: typeof context?.scopeLevel === 'string' ? context.scopeLevel as McpScopeLevel : undefined,
        grantedScopes: Array.isArray(context?.scopes) ? context.scopes as readonly string[] : undefined,
      });

      if (!policyResult.allowed) {
        return {
          content: `MCP tool "${this.name}" denied: ${policyResult.reason ?? 'Policy rejected execution'}`,
          isError: true,
          metadata: {
            server: this.schema.serverName,
            originalTool: this.schema.originalName,
            elapsed: 0,
            violationCode: policyResult.violationCode,
          },
        };
      }

      const effectiveArgs = policyResult.modifiedArguments ?? normalizedArgs;

      if (policyResult.requiresApproval) {
        return this.handleApprovalRequirement({
          args: effectiveArgs,
          context,
          reason: policyResult.approvalReason ?? 'Policy requires approval',
          scopeLevel: typeof context?.scopeLevel === 'string' ? context.scopeLevel as McpScopeLevel : 'subagent',
          agentId: typeof context?.agentId === 'string' ? context.agentId : undefined,
          start,
        });
      }

      return this.executeWithResolvedArgs(effectiveArgs, context, start);
    }

    this.logger?.debug('MCP tool call start', {
      tool: this.name,
      server: this.schema.serverName,
      originalTool: this.schema.originalName,
      correlationId: context?.sessionId,
    });

    // ── GAP-C: Circuit Breaker wrapping ───────────────────────────
    return this.executeWithResolvedArgs(normalizedArgs, context, start);
  }

  private async executeWithResolvedArgs(
    args: ToolArgumentBag,
    context: ToolExecutionContext | undefined,
    start: number,
  ): Promise<ToolExecutionResult> {
    if (this.circuitBreaker) {
      return this.executeWithCircuitBreaker(args, context, start);
    }

    return this.executeCall(args, context, start);
  }

  /**
   * Wrap the MCP call in a CircuitBreaker to protect agent token budget
   * from "failure storms" of a broken MCP server.
   *
   * FIX: GAP-C (Academic Audit March 2026)
   */
  private async executeWithCircuitBreaker(
    args: ToolArgumentBag,
    context: ToolExecutionContext | undefined,
    start: number,
  ): Promise<ToolExecutionResult> {
    const cbResult: CircuitBreakerResult<ToolExecutionResult> =
      await this.circuitBreaker!.execute(async () => {
        return this.executeCall(args, context, start);
      });

    if (!cbResult.success) {
      const elapsed = Date.now() - start;
      const isOpen = cbResult.circuitBreakerWasOpen;
      const errMsg = isOpen
        ? `Circuit breaker OPEN for MCP server "${this.schema.serverName}" — call rejected to protect budget`
        : (cbResult.error?.message ?? 'Unknown circuit breaker error');

      this.logger?.warn('MCP tool circuit breaker tripped', {
        tool: this.name,
        server: this.schema.serverName,
        circuitOpen: isOpen,
        elapsed,
        correlationId: context?.sessionId,
      });

      return {
        content: `MCP tool "${this.name}" failed: ${errMsg}`,
        isError: true,
        status: 'failed',
        metadata: {
          server: this.schema.serverName,
          originalTool: this.schema.originalName,
          elapsed,
          circuitBreakerOpen: isOpen,
        },
      };
    }

    // ACA-02: Avoid non-null assertion — CB contract guarantees data on success
    return cbResult.data as ToolExecutionResult;
  }

  /**
   * Core MCP call logic — delegates to IMcpClientRegistry.
   */
  private async executeCall(
    args: ToolArgumentBag,
    context: ToolExecutionContext | undefined,
    start: number,
  ): Promise<ToolExecutionResult> {
    const result = await this.registry.callTool(
      this.name,
      args,
      context?.sessionId, // FIX: MCP-A10 — propagate correlationId for audit trail
    );

    const elapsed = Date.now() - start;

    if (!result.success) {
      this.logger?.warn('MCP tool call failed', {
        tool: this.name,
        error: result.error,
        elapsed,
        correlationId: context?.sessionId,
      });

      // Throw so CircuitBreaker counts this as a failure
      if (this.circuitBreaker) {
        throw new Error(result.error ?? 'MCP tool call failed');
      }

      return {
        content: `MCP tool "${this.name}" failed: ${result.error ?? 'Unknown error'}`,
        isError: true,
        status: 'failed',
        metadata: {
          server: this.schema.serverName,
          originalTool: this.schema.originalName,
          elapsed,
        },
      };
    }

    this.logger?.debug('MCP tool call success', {
      tool: this.name,
      elapsed,
      resultLength: result.result?.length ?? 0,
      truncated: result.truncated,
      correlationId: context?.sessionId,
    });

    return {
      content: result.result ?? '',
      isError: false,
      status: 'completed',
      metadata: {
        server: this.schema.serverName,
        originalTool: this.schema.originalName,
        elapsed,
        truncated: result.truncated ?? false,
      },
    };
  }

  /**
   * Serialization hint for event store / debug.
   */
  toJSON(): ToolArgumentBag {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      kind: 'mcp',
      serverName: this.schema.serverName,
      originalName: this.schema.originalName,
      scopes: this.scopes,
      hasCircuitBreaker: !!this.circuitBreaker,
      hasScopeGuard: !!this.scopeGuard,
      hasToolPolicy: !!this.toolPolicy,
      hasApprovalInterceptor: !!this.approvalInterceptor,
    };
  }

  private async handleApprovalRequirement(params: {
    args: ToolArgumentBag;
    context: ToolExecutionContext | undefined;
    reason: string;
    scopeLevel: McpScopeLevel;
    agentId?: string;
    start: number;
  }): Promise<ToolExecutionResult> {
    if (!this.approvalInterceptor) {
      this.logger?.error('MCP tool approval backend unavailable', {
        tool: this.name,
        scopeLevel: params.scopeLevel,
        correlationId: params.context?.sessionId,
        reason: params.reason,
      });

      return {
        content: `MCP tool "${this.name}" requires approval, but no approval interceptor is configured`,
        isError: true,
        status: 'failed',
        metadata: {
          server: this.schema.serverName,
          originalTool: this.schema.originalName,
          elapsed: 0,
          approvalRequired: true,
          approvalStatus: 'unavailable',
          scopeLevel: params.scopeLevel,
        },
      };
    }

    // FIX: SEC-BRIDGE-01 — Bound approval wait to prevent indefinite hangs.
    const APPROVAL_TIMEOUT_MS = 30_000;
    const approvalPromise = this.approvalInterceptor.requestApproval({
      toolName: this.name,
      arguments: params.args,
      reason: params.reason,
      correlationId: params.context?.sessionId,
      agentId: params.agentId,
      userId: params.context?.userId,
      sessionId: params.context?.sessionId,
      scopeLevel: params.scopeLevel,
    });

    let approvalTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      approvalTimeoutId = setTimeout(
        () => reject(new Error('Approval request timed out')),
        APPROVAL_TIMEOUT_MS,
      );
    });

    let approval: Awaited<typeof approvalPromise>;
    try {
      approval = await Promise.race([approvalPromise, timeoutPromise]);
    } catch (err) {
      this.logger?.warn('MCP tool approval timed out', {
        tool: this.name,
        timeoutMs: APPROVAL_TIMEOUT_MS,
        correlationId: params.context?.sessionId,
      });
      return {
        content: `MCP tool "${this.name}" approval timed out after ${APPROVAL_TIMEOUT_MS / 1000}s`,
        isError: true,
        status: 'failed',
        metadata: {
          server: this.schema.serverName,
          originalTool: this.schema.originalName,
          elapsed: APPROVAL_TIMEOUT_MS,
          approvalRequired: true,
          approvalStatus: 'timeout',
          scopeLevel: params.scopeLevel,
        },
      };
    } finally {
      if (approvalTimeoutId) {
        clearTimeout(approvalTimeoutId);
      }
    }

    if (approval.status === 'approved' || approval.status === 'auto_approved') {
      const executionResult = await this.executeWithResolvedArgs(params.args, params.context, params.start);
      return {
        ...executionResult,
        metadata: {
          ...(executionResult.metadata ?? {}),
          approvalRequired: true,
          approvalStatus: approval.status,
          approvalId: approval.id,
          scopeLevel: params.scopeLevel,
        },
      };
    }

    if (approval.status === 'denied' || approval.status === 'expired' || approval.status === 'timeout') {
      return {
        content: `MCP tool "${this.name}" approval ${approval.status} before execution`,
        isError: true,
        status: 'failed',
        metadata: {
          server: this.schema.serverName,
          originalTool: this.schema.originalName,
          elapsed: 0,
          approvalRequired: true,
          approvalStatus: approval.status,
          approvalId: approval.id,
          scopeLevel: params.scopeLevel,
        },
      };
    }

    return {
      content: `MCP tool "${this.name}" is pending approval before execution`,
      isError: false,
      status: 'approval_required',
      metadata: {
        server: this.schema.serverName,
        originalTool: this.schema.originalName,
        elapsed: 0,
        approvalRequired: true,
        approvalStatus: approval?.status ?? 'pending',
        approvalId: approval?.id,
        scopeLevel: params.scopeLevel,
      },
    };
  }
}
