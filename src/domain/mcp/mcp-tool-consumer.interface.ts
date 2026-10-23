/**
 * IMcpToolConsumer — Domain Port for MCP Client (external tool consumption)
 *
 * Layer: Domain (port / contract)
 *
 * Consumes tools from external MCP servers.
 * Supports stdio (subprocess), SSE (HTTP legacy), and Streamable HTTP (March 2025+) transports.
 *
 * Implementation resides in Infrastructure; resolution via DI only:
 *   container.resolve<IMcpToolConsumer>(DI_TOKENS.IMcpToolConsumer)
 *
 * Connection Lifecycle:
 * - Singleton stdio connections (long-lived subprocess)
 * - Per-request HTTP connections
 * - Register with GracefulShutdown for cleanup
 *
 * Security:
 * - SSE/HTTP URLs MUST pass ISsrfDnsGuard.validate() before connection
 * - Tool calls MUST pass IToolExecutionPolicy.evaluate() before execution
 *
 * @see Book Ch.10 "MCP" — MCP Client, Stdio/SSE Connection
 * @see MCP Streamable HTTP transport spec (March 2025+)
 * @see https://modelcontextprotocol.io/specification
 */

import type { CorrelationId } from '../../core/types/branded';

// ─── Value Types ──────────────────────────────────────────────────────

/** Supported MCP transport types */
export type McpTransport = 'stdio' | 'sse' | 'streamable-http';

/** Connection parameters for establishing an MCP session */
export interface McpConnectionParams {
  /** Transport type to use for the connection */
  readonly transport: McpTransport;
  /** For stdio: command to spawn (e.g., "npx") */
  readonly command?: string;
  /** For stdio: arguments for the command (e.g., ["-y", "@some/mcp-server"]) */
  readonly args?: readonly string[];
  /** For SSE/Streamable HTTP: endpoint URL (e.g., "http://localhost:3001/sse") */
  readonly url?: string;
  /** Environment variables to pass to subprocess (stdio only) */
  readonly env?: Readonly<Record<string, string>>;
  /** Connection timeout in milliseconds (default: 30_000) */
  readonly timeoutMs?: number;
}

/** A tool discovered from an external MCP server */
export interface McpTool {
  /** Unique tool name within the MCP server */
  readonly name: string;
  /** Human-readable description for the LLM */
  readonly description: string;
  /** JSON Schema describing the tool's input parameters */
  readonly inputSchema: unknown;
}

/** A resource exposed by an external MCP server */
export interface McpResource {
  /** Resource URI (e.g., "file:///path/to/file") */
  readonly uri: string;
  /** Human-readable resource name */
  readonly name: string;
  /** MIME type of the resource content */
  readonly mimeType?: string;
}

/** Result of a tool invocation */
export interface McpToolResult {
  /** Tool output content */
  readonly content: unknown;
  /** Whether the tool invocation resulted in an error */
  readonly isError: boolean;
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for consuming tools from external MCP servers.
 *
 * Domain/Application layers consume this interface; concrete adapter
 * lives in Infrastructure and is registered via DI token `IMcpToolConsumer`.
 */
export interface IMcpToolConsumer {
  /**
   * Connect to an external MCP server.
   * For stdio: spawns a subprocess.
   * For SSE/HTTP: establishes an HTTP connection.
   *
   * @throws McpConnectionError — if connection fails or times out
   */
  connect(
    params: McpConnectionParams,
    correlationId: CorrelationId,
  ): Promise<void>;

  /**
   * List all tools available from the connected MCP server.
   *
   * @throws McpConnectionError — if not connected
   */
  listTools(
    correlationId: CorrelationId,
  ): Promise<readonly McpTool[]>;

  /**
   * Invoke a tool on the connected MCP server.
   * Must pass IToolExecutionPolicy.evaluate() before execution.
   *
   * @throws McpConnectionError — if not connected
   * @throws A2ATaskError — if tool execution fails
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    correlationId: CorrelationId,
  ): Promise<McpToolResult>;

  /**
   * List all resources available from the connected MCP server.
   *
   * @throws McpConnectionError — if not connected
   */
  listResources(
    correlationId: CorrelationId,
  ): Promise<readonly McpResource[]>;

  /**
   * Disconnect from the MCP server and release resources.
   * Safe to call if already disconnected.
   */
  disconnect(correlationId?: CorrelationId): Promise<void>;

  /** Returns true if currently connected to an MCP server */
  isConnected(): boolean;
}
