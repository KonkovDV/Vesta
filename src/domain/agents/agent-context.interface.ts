
/**
 * Agent Execution Context
 * Defined in Phase 18 for Atomic Tooling.
 */
export interface IAgentContext {
  /**
   * The ID of the agent executing the tool.
   * e.g. "research-agent-1"
   */
  readonly agentId: string;

  /**
   * The active session ID.
   * e.g. "session-uuid"
   */
  readonly sessionId: string;

  /**
   * Configuration object for the agent/tool.
   */
  readonly config: Record<string, unknown>;

  /**
   * The ABSOLUTE path to the root of the workspace.
   * Plugins should never exit this root.
   */
  readonly workspaceRoot: string;

  /**
   * True only after a person has approved this exact call.
   * The tool registry runs a body that requires approval only when this is set.
   */
  readonly approvalGranted?: boolean;
}
