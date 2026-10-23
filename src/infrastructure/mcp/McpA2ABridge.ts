/**
 * McpA2ABridge — Infrastructure adapter bridging MCP tools to A2A skills
 * Layer: Infrastructure (adapter)
 *
 * Maps IMcpServer tool definitions to A2A AgentSkill format and provides
 * a unified invocation path. This bridge enables A2A remote agents to
 * discover and invoke local MCP tools through the Agent Card.
 *
 * Transport: delegates to IMcpServer.callTool() for both Stdio and SSE
 * MCP tool registries. The bridge itself is protocol-agnostic.
 *
 * @Horizon 1 — Physical MCP↔A2A Integration
 * @see src/domain/mcp/IMcpBridge.ts — port interface
 * @see src/domain/mcp/IMcpServer.ts — MCP server port
 * @see src/infrastructure/mcp/context/MicroPhoenixMcpServer.ts — context tools (stdio)
 * @see src/infrastructure/mcp/McpMemoryServer.ts — memory tools (SSE)
 */

import { randomUUID } from 'node:crypto';
import type {
  IMcpBridge,
  McpBridgeToolResult,
  McpBridgeListOptions,
} from '../../domain/mcp/IMcpBridge';
import type { AgentSkill } from '../../domain/a2a/IAgentCardProvider';
import type { IMcpServer, McpSessionContext } from '../../domain/mcp/IMcpServer';

// FIX: MCPS-M8 — Use canonical ILogger from core instead of re-defining a local subset.
// This prevents signature drift and maintains DRY compliance.
import type { ILogger } from '../../core/decorators/ILogger';
import { sanitizeError } from './shared/mcp-utils';

/**
 * McpA2ABridge — maps MCP tool definitions to A2A skills and routes invocations.
 *
 * @example
 * const bridge = new McpA2ABridge(mcpServer, logger);
 * const skills = await bridge.listToolsAsSkills();
 * const result = await bridge.invokeTool('get_di_tokens_by_domain', { domain: 'events' });
 */
export class McpA2ABridge implements IMcpBridge {
  private readonly ready: boolean;

  constructor(
    private readonly mcpServer: IMcpServer | undefined,
    private readonly logger?: ILogger,
  ) {
    this.ready = mcpServer != null;
  }

  /**
   * Map MCP tool definitions to A2A AgentSkill format.
   *
   * Each MCP tool becomes an A2A skill with:
   * - id = 'mcp_' + tool.name (namespaced to avoid collisions)
   * - inputModes/outputModes from tool schema
   */
  async listToolsAsSkills(_options?: McpBridgeListOptions): Promise<readonly AgentSkill[]> {
    if (!this.mcpServer) {
      return [];
    }

    const tools = this.mcpServer.listTools();
    return tools.map((tool) => ({
      id: `mcp_${tool.name}`,
      name: this.humanize(tool.name),
      description: tool.description,
      inputModes: ['application/json'] as readonly string[],
      outputModes: ['application/json', 'application/x-yaml'] as readonly string[],
    }));
  }

  /**
   * Invoke an MCP tool through the bridge.
   *
   * Creates a synthetic McpSessionContext for the A2A caller,
   * then delegates to the underlying IMcpServer.
   */
  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    correlationId?: string,
    /** FIX: MCPS-H6 — Accept callerId to support per-user ACLs.
     *  Previously hardcoded to 'a2a-bridge', bypassing all user-scoped access control. */
    callerId?: string,
  ): Promise<McpBridgeToolResult> {
    if (!this.mcpServer) {
      return {
        toolName,
        content: [{ type: 'text', text: 'MCP Bridge not connected: no IMcpServer available' }],
        isError: true,
        durationMs: 0,
      };
    }

    // FIX: SEC-A2A-01 — Reject empty/whitespace callerId to prevent ACL bypass.
    // A blank callerId would fall back to 'a2a-bridge' (unscoped), bypassing per-user access control.
    if (callerId !== undefined && !callerId.trim()) {
      return {
        toolName,
        content: [{ type: 'text', text: 'callerId must not be empty or whitespace' }],
        isError: true,
        durationMs: 0,
      };
    }

    const startMs = Date.now();
    const context: McpSessionContext = {
      // FIX: MCPS-H6 — Use callerId if provided, fallback to 'a2a-bridge' for backward compat.
      userId: callerId?.trim() || 'a2a-bridge',
      clientName: 'a2a-agent',
      // FIX: SOTA-MCP-02 — crypto.randomUUID() for session uniqueness (Date.now() is predictable)
      sessionId: correlationId ?? `a2a-${randomUUID()}`,
    };

    try {
      const result = await this.mcpServer.callTool(toolName, args, context);
      const durationMs = Date.now() - startMs;

      this.logger?.info('mcp_bridge_tool_invoked', {
        tool_name: toolName,
        duration_ms: durationMs,
        is_error: result.isError ?? false,
        correlation_id: correlationId,
      });

      return {
        toolName,
        content: result.content.map((c) => ({ type: c.type, text: c.text })),
        isError: result.isError ?? false,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startMs;
      this.logger?.error('mcp_bridge_tool_error', {
        tool_name: toolName,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: durationMs,
        correlation_id: correlationId,
      });

      // FIX: SEC-A2A-02 — Sanitize error messages to prevent credential/path leakage (OWASP LLM07).
      const rawMsg = error instanceof Error ? error.message : String(error);
      return {
        toolName,
        content: [{
          type: 'text',
          text: `Tool invocation failed: ${sanitizeError(rawMsg)}`,
        }],
        isError: true,
        durationMs,
      };
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Convert snake_case tool name to human-readable label.
   * e.g. 'get_di_tokens_by_domain' → 'Get DI Tokens By Domain'
   */
  private humanize(name: string): string {
    return name
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}
