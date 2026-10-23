/**
 * Tool Execution Policy Interface
 * Layer: Domain (Security)
 *
 * Defines the contract for validating whether a tool is allowed to execute
 * based on the current context, tool name, and arguments.
 */

export interface ToolExecutionRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  agentId?: string;
  userId?: string;
  sessionId?: string;
  traceId?: string;
  scopeLevel?: 'project' | 'user' | 'subagent';
  grantedScopes?: readonly string[];
}

/**
 * Outcome of one proposed action.
 * `allowed` without `requiresApproval` means the action may run.
 * `allowed: false` means it is blocked.
 * `requiresApproval` means a person must decide before it runs.
 * `violationCode` names why a blocked action is outside the caller's policy.
 * A project supplies the rules. This contract does not know the project's states.
 */
export interface ToolPolicyResult {
  allowed: boolean;
  reason?: string;
  violationCode?: string; // e.g., 'DENIED_BY_BLACKLIST', 'INVALID_ARGS'
  modifiedArguments?: Record<string, unknown>; // Optional: Policy sanitizes args
  requiresApproval?: boolean;
  approvalReason?: string;
}

/**
 * Unified global deny list for tool execution (SEC-11).
 * Both Application and Infrastructure policy services MUST use this
 * canonical set to keep security boundaries consistent.
 */
export const GLOBAL_TOOL_DENY_LIST: ReadonlySet<string> = new Set([
  'eval',
  'exec',
  'system_shell',
  'debug_backdoor',
  'process.exit',
  'child_process.exec',
]);

export interface IToolExecutionPolicy {
  /**
   * Evaluate whether the tool execution is allowed.
   * @param request The tool execution context and arguments.
   * @returns A promise resolving to the policy result.
   */
  evaluate(request: ToolExecutionRequest): Promise<ToolPolicyResult>;
}
