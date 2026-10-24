
import { injectable, inject } from 'inversify';
import { ILogger } from '../../core/decorators/ILogger';
import type { IToolPolicyResolver, ToolProfileId } from '../../domain/security/tool-policy-resolver.port';
import { IToolExecutionPolicy, ToolExecutionRequest, ToolPolicyResult, GLOBAL_TOOL_DENY_LIST } from '../../domain/security/tool-execution-policy.interface';

/**
 * Canonical tool names (after aliasing) that need a person's approval by default:
 * code execution, writes, outgoing messages, the browser, session control and
 * automation. TOOL_APPROVAL_REQUIRED replaces the list (names or group:x, comma
 * separated); an empty value turns approval off.
 */
export const DEFAULT_APPROVAL_REQUIRED = [
  'exec', 'process', 'write', 'edit', 'apply_patch',
  'group:messaging', 'send_message', 'sessions_send', 'sessions_spawn',
  'browser', 'web-browser.navigate', 'web-browser.screenshot',
  'fs_write_file', 'group:automation',
];

@injectable()
export class ToolPolicyService implements IToolExecutionPolicy {
  /** Policies added by kernel extensions. They can deny or require approval, never allow more. */
  private readonly constraints: IToolExecutionPolicy[] = [];

  constructor(
    @inject('ILogger') private readonly logger: ILogger,
    @inject('IToolPolicyResolver') private readonly policyResolver: IToolPolicyResolver,
    private readonly approvalRequired: readonly string[] = approvalListFromEnv(),
  ) {}

  /** Tighten-only: the result is the strictest of the kernel decision and every constraint. */
  addConstraint(policy: IToolExecutionPolicy): void {
    this.constraints.push(policy);
  }

  /**
   * Evaluate whether the tool execution is allowed.
   */
  async evaluate(request: ToolExecutionRequest): Promise<ToolPolicyResult> {
    const { toolName, agentId } = request;
    
    // AgentId is mandatory for RBAC, if missing, default to stricter check or deny
    const effectiveAgentId = agentId || 'anonymous';

    const allowed = this.canExecute(effectiveAgentId, toolName);

    if (!allowed) {
      this.logger.warn('tool_policy_decision', {
        decision: 'deny',
        toolName,
        agentId: effectiveAgentId,
        userId: request.userId,
        sessionId: request.sessionId,
        traceId: request.traceId,
      });
      return {
        allowed: false,
        reason: `Tool '${toolName}' denied for agent '${effectiveAgentId}' by policy.`,
        violationCode: 'DENIED_BY_POLICY'
      };
    }

    let requiresApproval = this.needsApproval(toolName);
    let approvalReason = requiresApproval ? `Tool '${toolName}' has effects outside the conversation` : undefined;
    for (const constraint of this.constraints) {
      const extra = await constraint.evaluate(request);
      if (!extra.allowed) {
        this.logger.warn('tool_policy_decision', { decision: 'deny', source: 'extension', toolName, agentId: effectiveAgentId });
        return { allowed: false, reason: extra.reason ?? 'denied by an extension policy', violationCode: extra.violationCode ?? 'DENIED_BY_EXTENSION' };
      }
      if (extra.requiresApproval) {
        requiresApproval = true;
        approvalReason = extra.approvalReason ?? approvalReason ?? 'required by an extension policy';
      }
    }

    this.logger.info('tool_policy_decision', {
      decision: requiresApproval ? 'ask' : 'allow',
      toolName,
      agentId: effectiveAgentId,
      userId: request.userId,
      sessionId: request.sessionId,
      traceId: request.traceId,
    });

    return requiresApproval ? { allowed: true, requiresApproval: true, approvalReason } : { allowed: true };
  }

  private needsApproval(toolName: string): boolean {
    const raw = toolName.trim().toLowerCase();
    const canonical = this.policyResolver.normalizeToolName(toolName);
    const listed = new Set(this.policyResolver.expandToolGroups([...this.approvalRequired]));
    return listed.has(raw) || listed.has(canonical);
  }

  /**
   * Determine if an agent is allowed to execute a specific tool.
   * Legacy method kept for backward compatibility if needed, but logic is now used by evaluate.
   */
  canExecute(agentId: string, toolName: string): boolean {
    const normalizedName = this.policyResolver.normalizeToolName(toolName);

    // 1. Global Blocklist (Safety First). Checked on the name as called: bash and
    // python alias to the canonical 'exec', and the canonical name collided with the
    // literal 'exec' entry, so the contained shell tools were always denied.
    if (this.isGloballyBlocked(toolName.trim().toLowerCase())) {
      this.logger.warn(`ToolPolicy: Blocked global forbidden tool '${normalizedName}' for '${agentId}'`);
      return false;
    }

    // 2. Role-Based Access Control (RBAC)
    // Map agent roles to Tool Profiles
    // An agent id without a registered role gets 'minimal' (session_status only).
    // The id is a label set by server code; callers must not let a client choose it.
    const profile = this.getProfileForAgent(agentId);

    const policy = this.policyResolver.resolveToolProfilePolicy(profile);
    if (!policy) {
      return false;
    }

    // Check Deny List first
    if (policy.deny?.includes(normalizedName)) {
      return false;
    }

    // Check Allow List
    if (policy.allow) {
      // Canonical expansion using infrastructure logic
      const expandedAllowList = this.policyResolver.expandToolGroups(policy.allow);
      
      if (expandedAllowList.includes(normalizedName)) {
        return true;
      }
      
      // If specific allow list exists and we didn't match, deny.
      return false;
    }

    return true;
  }

  private isGloballyBlocked(toolName: string): boolean {
    return GLOBAL_TOOL_DENY_LIST.has(toolName);
  }

  /**
   * Resolve agent role to tool profile using an explicit role registry.
   * Uses exact prefix matching to prevent agent-name spoofing (SEC-10).
   */
  private static readonly AGENT_ROLE_REGISTRY: ReadonlyMap<string, ToolProfileId> = new Map([
    ['architect', 'coding'],
    ['implementer', 'coding'],
    ['senior-software-engineer', 'coding'],
    ['coder', 'coding'],
    ['agent-run', 'coding'],
    ['researcher', 'full'],
    ['analyst', 'full'],
    ['assistant', 'messaging'],
    ['messenger', 'messaging'],
  ]);

  private getProfileForAgent(agentId: string): ToolProfileId | undefined {
    const normalizedId = agentId.trim().toLowerCase();
    for (const [role, profile] of ToolPolicyService.AGENT_ROLE_REGISTRY) {
      if (normalizedId === role || normalizedId.startsWith(`${role}-`) || normalizedId.startsWith(`${role}.`)) {
        return profile;
      }
    }
    return 'minimal';
  }
}

function approvalListFromEnv(): string[] {
  const raw = process.env.TOOL_APPROVAL_REQUIRED;
  if (raw === undefined) return [...DEFAULT_APPROVAL_REQUIRED];
  return raw.split(',').map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0);
}
