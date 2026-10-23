/**
 * IMcpClientRegistry — Domain port for MCP (Model Context Protocol) client connections.
 *
 * Port of: `hermes-agent/tools/mcp_tool.py` (Hermes v2 — commit 152e080)
 *
 * Allows MicroPhoenix to connect TO external MCP servers (GitHub, filesystem,
 * databases, etc.) and discover/call their tools. This complements the existing
 * MCP server role (MicroPhoenixMcpServer.ts) where MicroPhoenix SERVES tools.
 *
 * Architecture:
 *  - Domain port defines the contract (this file)
 *  - Infrastructure adapter implements transport (stdio + HTTP/StreamableHTTP)
 *  - Each MCP server runs as a managed connection with reconnection
 *  - Tools are registered into the existing ToolsetRegistry
 *  - Environment variable filtering prevents credential leaks to subprocesses
 *  - Error messages are sanitized to strip secrets before returning to LLM
 *
 * @layer Domain (AI / Integration)
 * @since Hermes extraction H7 (MicroPhoenix v2.9.0)
 * @see https://modelcontextprotocol.io/ — MCP specification
 */

// ─── Configuration Types ─────────────────────────────────────────────────────

/**
 * Transport type for connecting to an MCP server.
 */
export type McpTransportType = 'stdio' | 'http';

/**
 * Configuration for a single MCP server connection.
 *
 * Supports two transport modes:
 * - `stdio`: Server runs as a local subprocess, communicating over stdin/stdout
 * - `http`: Server is remote, accessed over HTTP/StreamableHTTP
 */
export interface McpServerConfig {
  /** Unique server name (used for tool prefixing: `mcp_{name}_{tool}`) */
  readonly name: string;

  // ── Stdio transport ──

  /** Executable command for stdio servers (e.g., "npx", "uvx", "python") */
  readonly command?: string;
  /** Command-line arguments for the stdio command */
  readonly args?: readonly string[];
  /** Environment variables to pass to the subprocess (explicitly listed only) */
  readonly env?: Readonly<Record<string, string>>;

  // ── HTTP transport ──

  /** Full URL for HTTP/StreamableHTTP servers */
  readonly url?: string;
  /** HTTP headers for authentication (e.g., Authorization: Bearer) */
  readonly headers?: Readonly<Record<string, string>>;

  // ── Timeouts ──

  /** Tool call timeout in seconds (default: 120) */
  readonly timeout?: number;
  /** Initial connection timeout in seconds (default: 60) */
  readonly connectTimeout?: number;

  // ── Security (H5+H6 fix: MCP Spec v2025-06-18 §Security) ──

  /**
   * Maximum characters in a tool output before truncation.
   * Mitigates prompt injection from malicious MCP servers (OWASP LLM01:2025).
   * Default: 100_000 (100K chars).
   */
  readonly maxToolOutputChars?: number;

  /**
   * Rate limit: max tool invocations per minute per server.
   * MCP Spec v2025-06-18 §Security recommends rate limiting for tool invocations.
   * Default: 60 (1/sec average).
   */
  readonly maxCallsPerMinute?: number;
}

// ─── MCP Tool Schema ─────────────────────────────────────────────────────────

/**
 * Schema for a discovered MCP tool.
 *
 * Tools are registered with a prefixed name: `mcp_{serverName}_{toolName}`.
 * Hyphens and dots are replaced with underscores for API compatibility.
 */
export interface McpToolSchema {
  /** Prefixed tool name (e.g., "mcp_github_create_issue") */
  readonly name: string;
  /** Tool description from the MCP server */
  readonly description: string;
  /** JSON Schema for the tool's input parameters */
  readonly parameters: Record<string, unknown>;
  /** Server name this tool belongs to */
  readonly serverName: string;
  /** Original (unprefixed) tool name from the MCP server */
  readonly originalName: string;

  /**
   * RBAC scopes required to invoke this tool.
   *
   * Derived from MCP tool annotations (e.g., `destructiveHint`, `idempotentHint`)
   * and/or server-level configuration. When present, `ToolRegistry` / `McpToolBridge`
   * SHOULD verify that the caller's session grants all listed scopes before execution
   * (Principle of Least Privilege, MCP Spec §Security v2025-06-18+).
   *
   * Examples: `['mcp:read']`, `['mcp:write', 'mcp:destructive']`.
   * If empty or undefined — tool is considered unrestricted (read-only default).
   *
   * @since v2.9.0 — GAP-Rec-3 (Academic Audit March 2026)
   */
  readonly scopes?: readonly string[];
}

// ─── MCP Resource & Prompt ───────────────────────────────────────────────────

/**
 * MCP resource descriptor.
 */
export interface McpResource {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/**
 * MCP prompt descriptor.
 */
export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }>;
}

// ─── Server Status ───────────────────────────────────────────────────────────

/**
 * Connection status for an MCP server.
 */
export interface McpServerStatus {
  /** Server name */
  readonly name: string;
  /** Transport type used */
  readonly transport: McpTransportType;
  /** Number of discovered tools */
  readonly toolCount: number;
  /** Whether the server is currently connected */
  readonly connected: boolean;
  /** Error message if connection failed */
  readonly error?: string;
}

// ─── Tool Call Result ────────────────────────────────────────────────────────

/**
 * Result of calling an MCP tool.
 */
export interface McpToolCallResult {
  /** Whether the call succeeded */
  readonly success: boolean;
  /** Tool output (text content from response blocks, truncated to maxToolOutputChars) */
  readonly result?: string;
  /** Sanitized error message (credentials stripped) */
  readonly error?: string;
  /** Whether the output was truncated due to maxToolOutputChars limit */
  readonly truncated?: boolean;
}

// ─── Domain Port ─────────────────────────────────────────────────────────────

/**
 * IMcpClientRegistry — Domain port for managing MCP server connections.
 *
 * Connects to external MCP servers, discovers their tools, and provides
 * a unified interface for tool invocation with security guarantees.
 *
 * Implementation in Infrastructure layer handles:
 * - Transport management (stdio subprocess / HTTP connections)
 * - Reconnection with exponential backoff (up to 5 retries)
 * - Environment variable filtering for subprocess security
 * - Credential stripping from error messages
 * - Thread-safe connection lifecycle management
 * - Output truncation to maxToolOutputChars (prompt injection mitigation, OWASP LLM01)
 * - Rate limiting per server (MCP Spec v2025-06-18 §Security)
 * - OAuth 2.0 resource parameter (RFC 8707) for token binding (auth is infra concern)
 *
 * @example
 * ```typescript
 * const registry = container.resolve<IMcpClientRegistry>(DI_TOKENS.IMcpClientRegistry);
 *
 * // Connect to configured servers
 * const tools = await registry.discoverTools();
 *
 * // Call a tool
 * const result = await registry.callTool('mcp_github_create_issue', {
 *   title: 'Bug report',
 *   body: 'Description',
 * });
 *
 * // Check server status
 * const statuses = registry.getStatus();
 * ```
 */
export interface IMcpClientRegistry {
  /**
   * Load configuration and connect to all configured MCP servers.
   * Discovers their tools and registers them.
   *
   * Idempotent: only connects to servers not already connected.
   *
   * @returns List of all registered MCP tool schemas.
   */
  discoverTools(): Promise<readonly McpToolSchema[]>;

  /**
   * Call a tool on a connected MCP server.
   *
   * @param toolName - Prefixed tool name (e.g., "mcp_github_create_issue").
   * @param args - Tool arguments as a JSON-serializable object.
   * @param correlationId - Optional correlation ID for audit trail propagation.
   * @returns Tool call result with sanitized errors.
   */
  callTool(toolName: string, args: Record<string, unknown>, correlationId?: string): Promise<McpToolCallResult>;

  /**
   * List resources from a connected MCP server.
   *
   * @param serverName - Server name to query.
   * @returns Array of available resources.
   */
  listResources(serverName: string): Promise<readonly McpResource[]>;

  /**
   * Read a resource by URI from a connected MCP server.
   *
   * @param serverName - Server name to query.
   * @param uri - Resource URI to read.
   * @returns Resource content as text.
   */
  readResource(serverName: string, uri: string): Promise<string>;

  /**
   * List prompts from a connected MCP server.
   *
   * @param serverName - Server name to query.
   * @returns Array of available prompts.
   */
  listPrompts(serverName: string): Promise<readonly McpPrompt[]>;

  /**
   * Get a prompt by name from a connected MCP server.
   *
   * @param serverName - Server name to query.
   * @param name - Prompt name.
   * @param args - Optional prompt arguments.
   * @returns Prompt messages.
   */
  getPrompt(serverName: string, name: string, args?: Record<string, unknown>): Promise<ReadonlyArray<{ role: string; content: string }>>;

  /**
   * Get connection status for all configured MCP servers.
   */
  getStatus(): readonly McpServerStatus[];

  /**
   * Gracefully shut down all MCP server connections.
   */
  shutdown(): Promise<void>;
}
