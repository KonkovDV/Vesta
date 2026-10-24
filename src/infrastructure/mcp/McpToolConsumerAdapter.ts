/**
 * McpToolConsumerAdapter — Infrastructure Adapter
 *
 * Consumes tools from external MCP servers using @modelcontextprotocol/client v2.
 * Supports stdio (subprocess), SSE (legacy), and Streamable HTTP transports.
 *
 * Best Practices Applied (March 2026):
 * - MCP Streamable HTTP spec (March 2025+): session management, resumability
 * - Transport auto-detection: POST first → fallback to legacy SSE
 * - Connection lifecycle: singleton stdio, per-request HTTP
 * - SSE and streamable HTTP use createPinnedFetch when a DNS guard is passed in
 * - Tool calls auditable via structured logging with correlationId
 *
 * DI: constructor(logger, configLoader, toolPolicy?, guard?)
 *
 * @see Book Ch.10 "MCP" — MCP Client, Stdio/SSE Connection
 * @see https://modelcontextprotocol.io/specification
 */

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ConfigLoader } from '../../config/ConfigLoader';
import type {
  IMcpToolConsumer,
  McpConnectionParams,
  McpTool,
  McpResource,
  McpToolResult,
} from '../../domain/mcp/mcp-tool-consumer.interface';
import type { IToolExecutionPolicy, ToolExecutionRequest } from '../../domain/security/tool-execution-policy.interface';
import { McpConnectionError } from '../../domain/errors/agentic-errors';
import { createPinnedFetch } from '../http/SsrfPinnedHttpClient';
import type { PinnedEndpoint } from '../security/SsrfDnsGuard';

const DEFAULT_TIMEOUT_MS = 30_000;

export class McpToolConsumerAdapter implements IMcpToolConsumer {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connected = false;

  constructor(
    private readonly logger: ILogger,
    private readonly configLoader: ConfigLoader,
    private readonly toolPolicy?: IToolExecutionPolicy,
    /** When present, SSE and streamable HTTP connect to the addresses pinUrl checked. MP-K10. */
    private readonly guard?: { pinUrl(url: string): Promise<PinnedEndpoint> },
  ) {}

  async connect(
    params: McpConnectionParams,
    correlationId: CorrelationId,
  ): Promise<void> {
    if (this.connected) {
      await this.disconnect(correlationId);
    }

    this.logger.info('McpToolConsumerAdapter.connect', {
      correlationId,
      transport: params.transport,
      url: params.url,
      command: params.command,
    });

    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      this.transport = this.createTransport(params);
      this.client = this.createClient();

      // Register transport close/error handlers BEFORE connect to avoid
      // race condition: if server closes during handshake, handlers must
      // already be installed to detect mid-connect disconnection.
      if (this.transport) {
        this.transport.onclose = () => {
          this.connected = false;
          this.logger.warn('McpToolConsumerAdapter.transport.closed', {
            correlationId,
            transport: params.transport,
          });
        };
        this.transport.onerror = (error: Error) => {
          this.connected = false;
          this.logger.error('McpToolConsumerAdapter.transport.error', {
            correlationId,
            transport: params.transport,
            error: error.message,
          });
        };
      }

      const connectPromise = this.client.connect(this.transport);
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error('MCP connection timeout')),
          timeoutMs,
        );
      });

      try {
        await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        if (timerId) clearTimeout(timerId);
      }
      this.connected = true;

      this.logger.info('McpToolConsumerAdapter.connected', {
        correlationId,
        transport: params.transport,
      });
    } catch (error) {
      this.connected = false;
      this.client = null;
      this.transport = null;

      const message = error instanceof Error ? error.message : String(error);
      throw new McpConnectionError(
        `Failed to connect to MCP server: ${message}`,
        params.url ?? params.command ?? 'unknown',
        correlationId,
      );
    }
  }

  async listTools(correlationId: CorrelationId): Promise<readonly McpTool[]> {
    this.ensureConnected(correlationId);

    this.logger.info('McpToolConsumerAdapter.listTools', { correlationId });

    try {
      const result = await this.client!.listTools();

      const tools: McpTool[] = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }));

      this.logger.info('McpToolConsumerAdapter.listTools.complete', {
        correlationId,
        toolCount: tools.length,
      });

      return tools;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new McpConnectionError(
        `Failed to list tools: ${message}`,
        'connected-server',
        correlationId,
      );
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    correlationId: CorrelationId,
  ): Promise<McpToolResult> {
    this.ensureConnected(correlationId);

    // Enforce IToolExecutionPolicy before execution (S02-F2)
    if (this.toolPolicy) {
      const request: ToolExecutionRequest = {
        toolName: name,
        arguments: args,
        traceId: correlationId,
      };
      const policyResult = await this.toolPolicy.evaluate(request);
      if (!policyResult.allowed) {
        this.logger.warn('McpToolConsumerAdapter.callTool.denied', {
          correlationId,
          toolName: name,
          reason: policyResult.reason,
          violationCode: policyResult.violationCode,
        });
        throw new McpConnectionError(
          `Tool call '${name}' denied by policy: ${policyResult.reason ?? 'access denied'}`,
          'connected-server',
          correlationId,
        );
      }
    }

    this.logger.info('McpToolConsumerAdapter.callTool', {
      correlationId,
      toolName: name,
    });

    try {
      const result = await this.client!.callTool({ name, arguments: args });

      this.logger.info('McpToolConsumerAdapter.callTool.complete', {
        correlationId,
        toolName: name,
        isError: result.isError ?? false,
      });

      return {
        content: result.content,
        isError: result.isError === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new McpConnectionError(
        `Tool call '${name}' failed: ${message}`,
        'connected-server',
        correlationId,
      );
    }
  }

  async listResources(correlationId: CorrelationId): Promise<readonly McpResource[]> {
    this.ensureConnected(correlationId);

    this.logger.info('McpToolConsumerAdapter.listResources', { correlationId });

    try {
      const result = await this.client!.listResources();

      const resources: McpResource[] = (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        mimeType: r.mimeType,
      }));

      return resources;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new McpConnectionError(
        `Failed to list resources: ${message}`,
        'connected-server',
        correlationId,
      );
    }
  }

  async disconnect(correlationId?: CorrelationId): Promise<void> {
    if (!this.connected) return;

    this.logger.info('McpToolConsumerAdapter.disconnect', { correlationId });

    try {
      if (this.client) {
        await this.client.close();
      }
    } catch (error) {
      this.logger.warn('McpToolConsumerAdapter.disconnect.error', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.client = null;
      this.transport = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  protected createClient(): Client {
    return new Client(
      { name: 'MicroPhoenix-McpConsumer', version: '2.9.0' },
      // Default negotiation is the 2025 initialize handshake.
      { capabilities: {} },
    );
  }

  protected createTransport(params: McpConnectionParams): Transport {
    switch (params.transport) {
      case 'stdio': {
        if (!params.command) {
          throw new Error('stdio transport requires "command" parameter');
        }
        return new StdioClientTransport({
          command: params.command,
          args: params.args ? [...params.args] : [],
          env: params.env ? { ...params.env } : undefined,
        });
      }
      case 'sse': {
        if (!params.url) {
          throw new Error('sse transport requires "url" parameter');
        }
        return new SSEClientTransport(new URL(params.url), this.pinnedTransportOptions());
      }
      case 'streamable-http': {
        if (!params.url) {
          throw new Error('streamable-http transport requires "url" parameter');
        }
        return new StreamableHTTPClientTransport(new URL(params.url), this.pinnedTransportOptions());
      }
      default: {
        throw new Error('Unsupported MCP transport');
      }
    }
  }

  /** The SDK transports accept a fetch; the pinned one never re-resolves the host. */
  private pinnedTransportOptions(): { fetch: ReturnType<typeof createPinnedFetch> } | undefined {
    return this.guard ? { fetch: createPinnedFetch(this.guard) } : undefined;
  }

  private ensureConnected(correlationId: CorrelationId): void {
    if (!this.connected || !this.client) {
      throw new McpConnectionError(
        'Not connected to an MCP server. Call connect() first.',
        'none',
        correlationId,
      );
    }
  }
}
