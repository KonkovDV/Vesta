/**
 * IMcpServer — Domain port for Model Context Protocol server.
 *
 * Layer: Domain
 *
 * Abstracts the MCP protocol server interface so that Application/Domain layers
 * can reference it without knowing about SSE transport or Express details.
 *
 * Phase 7: Ported from OpenMemory mcp_server.py (Python → TypeScript).
 * Donor: external/mem0/openmemory/api/app/mcp_server.py (493L)
 */

/**
 * MCP tool definition exposed to clients.
 */
export interface McpToolDefinition {
  /** Unique tool name (e.g., 'add_memories', 'search_memory'). */
  readonly name: string;
  /** Human-readable description for the LLM. */
  readonly description: string;
  /** JSON Schema for tool input parameters. */
  readonly inputSchema: Record<string, unknown>;
  /** MCP 2025-03-26 tool annotations (optional). */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

/**
 * Result of an MCP tool invocation.
 */
export interface McpToolResult {
  /** Array of content blocks returned to the client. */
  content: Array<{ type: 'text'; text: string }>;
  /** Whether the tool invocation resulted in an error. */
  isError?: boolean;
  /** MCP 2025-06-18: structured JSON output validated against outputSchema (optional). */
  structuredContent?: Record<string, unknown>;
}

/**
 * Context for an MCP session (extracted from SSE connection params).
 */
export interface McpSessionContext {
  /** User identifier from the connection URL. */
  userId: string;
  /** Client application name (e.g., 'claude-desktop', 'cursor'). */
  clientName: string;
  /** Unique session identifier for this SSE connection. */
  sessionId: string;
}

/** Task state from the MCP tasks methods this server implements. */
export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskView {
  taskId: string;
  status: McpTaskStatus;
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
}

/**
 * Domain port for the MCP server.
 *
 * Infrastructure layer implements this with SSE transport + JSON-RPC 2.0.
 */
export interface IMcpServer {
  /** List all available MCP tools. */
  listTools(): McpToolDefinition[];

  /** Execute a tool by name with given arguments in a session context. */
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult>;

  /**
   * Gracefully close the server and release all resources.
   * FIX: MCPS-L3 — Added lifecycle method so consumers can signal cleanup through the port interface.
   * Optional for backward compatibility with existing implementations.
   */
  close?(): Promise<void>;

  /** MCP tasks/get. Absent on servers that do not expose agent runs. */
  getTask?(taskId: string): Promise<McpTaskView | undefined>;

  /** MCP tasks/cancel. Returns the task after the journal records the cancellation. */
  cancelTask?(taskId: string, context: McpSessionContext): Promise<McpTaskView | undefined>;

  /** MCP tasks/result. The body matches a tools/call result for run_agent. */
  taskResult?(taskId: string): Promise<McpToolResult | undefined>;
}
