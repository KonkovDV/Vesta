/**
 * IMcpBridge — Domain port for MCP↔A2A Tool Bridge
 * Layer: Domain (port / contract)
 *
 * Defines the contract for bridging MCP tools (Model Context Protocol)
 * to A2A agent skills. MCP provides local tool access for LLMs,
 * while A2A provides agent-to-agent discovery. This bridge maps
 * MCP tool definitions to A2A AgentSkill format, enabling:
 *
 *   - Discovery: Remote agents discover local MCP tools via Agent Card
 *   - Invocation: A2A requests are routed to MCP tool handlers
 *   - Observability: Unified logging across both protocols
 *
 * Implementation resides in Infrastructure; resolution via DI only:
 *   container.resolve<IMcpBridge>(DI_TOKENS.IMcpBridge)
 *
 * @Horizon 1 — Physical MCP↔A2A Integration
 * @see src/domain/mcp/IMcpServer.ts — MCP server port
 * @see src/domain/a2a/IAgentCardProvider.ts — A2A agent card port
 */

import type { AgentSkill } from '../a2a/IAgentCardProvider';

// ─── Value Types ──────────────────────────────────────────────────────

/** Result of an MCP tool invocation through the bridge */
export interface McpBridgeToolResult {
  /** Tool name that was invoked */
  readonly toolName: string;
  /** Content blocks returned by the tool */
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  /** Whether the invocation resulted in an error */
  readonly isError: boolean;
  /** Execution duration in milliseconds */
  readonly durationMs: number;
}

/** Options for listing available tools */
export interface McpBridgeListOptions {
  /** Filter tools by transport type */
  readonly transport?: 'stdio' | 'sse' | 'all';
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for bridging MCP tools to A2A agent skills.
 *
 * Domain/Application layers consume this interface; concrete adapter
 * lives in Infrastructure and is registered via DI token `IMcpBridge`.
 */
export interface IMcpBridge {
  /**
   * List all MCP tools available through the bridge, mapped to A2A AgentSkill format.
   *
   * @param options — optional filters (transport type, etc.)
   * @returns Array of AgentSkill descriptions
   */
  listToolsAsSkills(options?: McpBridgeListOptions): Promise<readonly AgentSkill[]>;

  /**
   * Invoke an MCP tool through the bridge.
   *
   * @param toolName — MCP tool name (e.g. 'get_di_tokens_by_domain')
   * @param args — Tool arguments (JSON-serializable)
   * @param correlationId — optional correlation ID for observability
   * @param callerId — optional caller identity for per-user ACLs (FIX: MCPS-H6)
   * @returns Tool invocation result
   */
  invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    correlationId?: string,
    callerId?: string,
  ): Promise<McpBridgeToolResult>;

  /**
   * Check if the bridge is connected and ready.
   */
  isReady(): boolean;
}
