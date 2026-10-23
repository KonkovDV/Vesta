/**
 * McpToolDiscoveryService — Lazy discovery + caching of MCP tools as IAgentTool.
 *
 * Bridges IMcpClientRegistry (infrastructure) with the agent ToolRegistry.
 * Discovers MCP tools on first request and caches them as McpToolBridge instances.
 *
 * Best Practices (March 2026):
 *  - Lazy initialization: discoverTools() not called at startup, only on first agent request
 *  - Deduplication: concurrent discovery calls share a single promise
 *  - Graceful degradation: on discovery error → returns empty set (no crash)
 *  - Cache invalidation: invalidate() when MCP server topology changes
 *
 * Layer: Application (depends on Domain port + McpToolBridge)
 * @see src/domain/ai/mcp-client-registry.port.ts — IMcpClientRegistry
 * @see src/application/agents/tools/McpToolBridge.ts — McpToolBridge adapter
 */

import type { IMcpClientRegistry, McpToolSchema } from '../../../domain/ai/mcp-client-registry.port';
import type { IAgentTool } from '../../../domain/ai/IAgentTool';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { ICircuitBreaker } from '../../../domain/external/ICircuitBreaker';
import type { IMcpScopeGuard } from '../../../domain/mcp/IMcpScopeGuard';
import type { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';
import type { IUserApprovalInterceptor } from '../../../domain/security/IUserApprovalInterceptor';
import { McpToolBridge } from '../tools/McpToolBridge';

/**
 * Interface for MCP tool discovery service (for DI and testability).
 */
export interface IMcpToolDiscoveryService {
  /** Get all MCP tools as IAgentTool instances (lazy discovery + cache). */
  getTools(): Promise<readonly IAgentTool[]>;
  /** Find a specific MCP tool by prefixed name. Returns null if not found. */
  findTool(name: string): Promise<IAgentTool | null>;
  /** Invalidate cached tools (e.g., after server reconnection). */
  invalidate(): void;
  /** Get count of currently cached tools. */
  readonly toolCount: number;
}

/**
 * Lazily discovers MCP tools and wraps them in IAgentTool adapters.
 *
 * Cache invalidation: call invalidate() when MCP server topology changes.
 * Concurrency: first call triggers discovery, subsequent calls get cached result.
 */
export class McpToolDiscoveryService implements IMcpToolDiscoveryService {
  private cache: Map<string, IAgentTool> | null = null;
  private discoveryPromise: Promise<Map<string, IAgentTool>> | null = null;

  /**
   * @param mcpRegistry — MCP client registry for tool discovery
   * @param logger — optional structured logger
   * @param circuitBreaker — optional circuit breaker for MCP tool calls
   *   SNG-001: protects agent token budget from broken MCP server failure storms.
   *   When provided, each McpToolBridge will wrap callTool() in CB.execute().
   * @param scopeGuard — optional IMcpScopeGuard for T16 scope-based access control.
   *   SOTA-MCP-SCOPE: When provided, each McpToolBridge delegates scope evaluation
   *   to the guard instead of inline array filtering.
   */
  constructor(
    private readonly mcpRegistry: IMcpClientRegistry,
    private readonly logger?: ILogger,
    private readonly circuitBreaker?: ICircuitBreaker,
    private readonly scopeGuard?: IMcpScopeGuard,
    private readonly toolPolicy?: IToolExecutionPolicy,
    private readonly approvalInterceptor?: IUserApprovalInterceptor,
  ) {}

  /**
   * Get all MCP tools as IAgentTool instances.
   * First call triggers discovery; subsequent calls return cached.
   */
  async getTools(): Promise<readonly IAgentTool[]> {
    if (this.cache) return Array.from(this.cache.values());

    // Deduplicate concurrent discovery calls
    if (!this.discoveryPromise) {
      this.discoveryPromise = this.discover();
    }

    this.cache = await this.discoveryPromise;
    this.discoveryPromise = null;

    return Array.from(this.cache.values());
  }

  /**
   * Find a specific MCP tool by name.
   * Returns null if tool not found (no error thrown).
   */
  async findTool(name: string): Promise<IAgentTool | null> {
    // Fast path: check cache without triggering full discovery
    if (this.cache) {
      return this.cache.get(name) ?? null;
    }

    // Trigger discovery (populates cache), then lookup
    await this.getTools();
    return this.lookupCached(name);
  }

  /**
   * Type-safe cache lookup — separate method avoids TypeScript
   * control-flow narrowing that treats this.cache as 'never' after
   * the if (this.cache) early-return in findTool().
   */
  private lookupCached(name: string): IAgentTool | null {
    return this.cache?.get(name) ?? null;
  }

  /**
   * Invalidate cached tools (e.g., after server reconnection).
   */
  invalidate(): void {
    this.cache = null;
    this.discoveryPromise = null;
    this.logger?.info('McpToolDiscoveryService: cache invalidated');
  }

  /**
   * Get count of discovered tools.
   */
  get toolCount(): number {
    return this.cache?.size ?? 0;
  }

  // ── Private ──

  private async discover(): Promise<Map<string, IAgentTool>> {
    const start = Date.now();
    this.logger?.info('McpToolDiscoveryService: discovery started');

    let schemas: readonly McpToolSchema[];
    try {
      schemas = await this.mcpRegistry.discoverTools();
    } catch (error) {
      this.logger?.error('McpToolDiscoveryService: discovery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }

    const toolMap = new Map<string, IAgentTool>();

    for (const schema of schemas) {
      // SNG-001: Pass circuitBreaker to each bridge for failure-storm protection
      // SOTA-MCP-SCOPE: Pass scopeGuard for T16 scope-based access control
      const bridge = new McpToolBridge(
        schema,
        this.mcpRegistry,
        this.logger,
        this.circuitBreaker,
        this.scopeGuard,
        this.toolPolicy,
        this.approvalInterceptor,
      );
      toolMap.set(schema.name, bridge);
    }

    const elapsed = Date.now() - start;
    const servers = [...new Set(schemas.map(s => s.serverName))];

    this.logger?.info('McpToolDiscoveryService: discovery complete', {
      toolCount: toolMap.size,
      elapsed,
      servers,
    });

    return toolMap;
  }
}
