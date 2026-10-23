
import { injectable, inject } from 'inversify';
import { ILogger } from '../../core/decorators/ILogger';
import type { IToolPolicyResolver, ToolProfileId } from '../../domain/security/tool-policy-resolver.port';
import { IToolExecutionPolicy, ToolExecutionRequest, ToolPolicyResult, GLOBAL_TOOL_DENY_LIST } from '../../domain/security/tool-execution-policy.interface';

@injectable()
export class ToolPolicyService implements IToolExecutionPolicy {
  constructor(
    @inject('ILogger') private readonly logger: ILogger,
    @inject('IToolPolicyResolver') private readonly policyResolver: IToolPolicyResolver
  ) {}

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

    this.logger.info('tool_policy_decision', {
      decision: 'allow',
      toolName,
      agentId: effectiveAgentId,
      userId: request.userId,
      sessionId: request.sessionId,
      traceId: request.traceId,
    });

    return { allowed: true };
  }

  /**
   * Determine if an agent is allowed to execute a specific tool.
   * Legacy method kept for backward compatibility if needed, but logic is now used by evaluate.
   */
  canExecute(agentId: string, toolName: string): boolean {
    const normalizedName = this.policyResolver.normalizeToolName(toolName);

    // 1. Global Blocklist (Safety First)
    if (this.isGloballyBlocked(normalizedName)) {
      this.logger.warn(`ToolPolicy: Blocked global forbidden tool '${normalizedName}' for '${agentId}'`);
      return false;
    }

    // 2. Role-Based Access Control (RBAC)
    // Map agent roles to Tool Profiles
    const profile = this.getProfileForAgent(agentId);
    if (!profile) {
      // Default deny if no profile matched
      this.logger.warn(`ToolPolicy: No profile found for agent '${agentId}', denying '${normalizedName}'`);
      return false;
    }

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
