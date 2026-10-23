/**
 * McpStreamableTransport — MCP Streamable HTTP transport for Express.
 *
 * Layer: Infrastructure
 * Protocol: MCP server package v2, Web Standard streamable HTTP, behind Express.
 *
 * The Express route stays the edge. Each session uses
 * WebStandardStreamableHTTPServerTransport and the v2 low-level Server.
 * Origin checks, body limits, session identity, and tool scope stay here.
 *
 * Key features (MCP spec 2025-03-26):
 *   - Single endpoint for POST/GET/DELETE
 *   - Session management via Mcp-Session-Id header
 *   - SSE resumability via EventStore interface + Last-Event-ID
 *   - JSON-RPC batching (handled by SDK)
 *   - Graceful session termination via DELETE
 *   - Cryptographic session IDs (randomUUID per MCP spec)
 *   - Origin validation for DNS rebinding protection
 *   - Body size limit enforcement (DoS protection)
 *
 * Phase 7 → SOTA: Migration from custom SSE to official SDK transport.
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
 */

import {
  INVALID_PARAMS,
  ProtocolError,
  Server,
  WebStandardStreamableHTTPServerTransport,
  fromJsonSchema,
  type EventId,
  type EventStore,
  type JSONRPCMessage,
  type StreamId,
} from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express-serve-static-core';
import { routeParam } from '../../core/http/route-param';
import type { IMcpServer, McpSessionContext } from '../../domain/mcp/IMcpServer';
import type { IMcpScopeGuard, McpScopeLevel } from '../../domain/mcp/IMcpScopeGuard';
import type { IToolExecutionPolicy } from '../../domain/security/tool-execution-policy.interface';
import { AGENT_RUN_SCOPE_TOOLS, RUN_AGENT_REQUIRED_SCOPE } from './RunAgentMcpServer';
import { advertisedTaskCapabilities } from './agent-task-capabilities';
import {
  AsyncLocalRequestContext,
  RequestContextFactory,
} from '../../core/context/request-context';
import { generateSecureToken } from '../../core/utils/TokenGenerator';
import {
  getMcpStreamableActiveSessionsGauge,
  getMcpStreamableLatencyHistogram,
  getMcpStreamableRequestsCounter,
  withMcpToolCallSpan,
} from '../../monitoring';
import { logger as defaultLogger } from '../logging/logger';

// ── Configuration ──────────────────────────────────────────────────

export interface McpStreamableTransportConfig {
  /** Maximum concurrent sessions (default: 1000 — DoS protection) */
  maxSessions?: number;
  /** Max request body size in bytes (default: 1MB) */
  maxBodyBytes?: number;
  /** Allowed origins for DNS rebinding protection (empty = allow all non-browser) */
  allowedOrigins?: string[];
  /** Enable SSE resumability via event store (default: false) */
  enableResumability?: boolean;
  /**
   * Optional request identity resolver.
   *
   * Use this when MCP transport is mounted behind authentication middleware so the
   * session identity is derived from authenticated request state instead of trusting
   * URL params alone.
   */
  resolveIdentity?: (req: Request) => Partial<McpStreamableRequestIdentity> | undefined;
  /**
   * Optional authenticated access context for scope and policy evaluation.
   */
  resolveAccessContext?: (req: Request) => Partial<McpStreamableAccessContext> | undefined;
}

type NormalizedMcpStreamableTransportConfig = Omit<
  Required<McpStreamableTransportConfig>,
  'resolveIdentity' | 'resolveAccessContext'
> & {
  resolveIdentity?: McpStreamableTransportConfig['resolveIdentity'];
  resolveAccessContext?: McpStreamableTransportConfig['resolveAccessContext'];
};

export interface McpStreamableRequestIdentity {
  clientName: string;
  userId: string;
}

export interface McpStreamableAccessContext {
  agentId: string;
  scopeLevel: McpScopeLevel;
  grantedScopes: readonly string[];
}

// ── MCP Protocol Constants ─────────────────────────────────────────

const MCP_SERVER_NAME = 'microphoenix-mcp';
const MCP_SERVER_VERSION = '2.9.0';

// ── Default allowed origins ────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'https://127.0.0.1',
];

// ── SDK-compatible In-Memory Event Store for resumability ──────────

interface StoredEvent {
  streamId: StreamId;
  eventId: EventId;
  message: JSONRPCMessage;
  storedAt: number;  // Date.now() timestamp for TTL cleanup
}

/**
 * In-memory EventStore for SSE resumability per MCP spec 2025-03-26.
 * Production deployments should replace with Redis/PostgreSQL store.
 */
class InMemoryEventStore implements EventStore {
  private events: StoredEvent[] = [];
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private counter = 0;

  constructor(maxEvents = 1000, maxAgeMs = 30 * 60 * 1000) {
    this.maxEvents = maxEvents;
    this.maxAgeMs = maxAgeMs;
    // Cleanup every 5 minutes, unref() to not block shutdown
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  /** Remove events older than maxAgeMs. */
  private cleanup(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    const before = this.events.length;
    this.events = this.events.filter(e => e.storedAt > cutoff);
    if (this.events.length < before) {
      process.stderr.write(JSON.stringify({
        event: 'mcp.event_store.cleanup',
        removed: before - this.events.length,
        remaining: this.events.length,
      }) + '\n');
    }
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = `evt_${++this.counter}`;
    this.events.push({ streamId, eventId, message, storedAt: Date.now() });
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const idx = this.events.findIndex((e) => e.eventId === lastEventId);
    if (idx === -1) {
      throw new Error(`Event ${lastEventId} not found — cannot resume`);
    }
    const streamId = this.events[idx].streamId;
    const remaining = this.events.slice(idx + 1).filter((e) => e.streamId === streamId);
    for (const event of remaining) {
      await send(event.eventId, event.message);
    }
    return streamId;
  }
}

// ── Session Tracking ───────────────────────────────────────────────

interface ManagedSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  clientName: string;
  userId: string;
  accessContext: McpStreamableAccessContext;
  /** Internal tracking ID (cryptographic, for logs/metrics) */
  trackingId: string;
  createdAt: number;
}

const HOP_BY_HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

/**
 * Express json() sets req.body and consumes the stream.
 * A route mounted without that middleware still has the bytes on the
 * Node request. The Web Request the SDK reads cannot see that stream,
 * so an unread body is parsed here before the request is rebuilt.
 */
async function readUnparsedJsonBody(req: Request): Promise<unknown> {
  if (req.body !== undefined) return req.body;
  const stream = req as Request & AsyncIterable<Buffer | string> & { readableEnded?: boolean };
  if (stream.readableEnded === true || typeof stream[Symbol.asyncIterator] !== 'function') {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function expressToWebRequest(req: Request, parsedBody: unknown): globalThis.Request {
  const hostHeader = req.headers?.host;
  const host = typeof hostHeader === 'string' && hostHeader.length > 0 ? hostHeader : '127.0.0.1';
  const forwarded = req.headers?.['x-forwarded-proto'];
  const proto = typeof forwarded === 'string' && forwarded.length > 0 ? forwarded : 'http';
  const path = req.originalUrl || req.url || '/';
  const url = `${proto}://${host}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    }
  }
  const method = req.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && parsedBody !== undefined) {
    init.body = JSON.stringify(parsedBody);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return new globalThis.Request(url, init);
}

async function writeWebResponse(res: Response, web: globalThis.Response): Promise<void> {
  res.status(web.status);
  if (typeof res.setHeader === 'function') {
    web.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
  }
  if (!web.body) {
    res.end();
    return;
  }
  const reader = web.body.getReader();
  const write = typeof res.write === 'function' ? res.write.bind(res) : undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    if (write) write(chunk);
  }
  res.end();
}

// ── Transport Class ────────────────────────────────────────────────

/**
 * McpStreamableTransport — Express-compatible MCP Streamable HTTP adapter.
 *
 * Bridges the Domain IMcpServer to the MCP SDK's StreamableHTTPServerTransport.
 * Each client session gets its own transport + Server pair for full isolation.
 *
 * Usage in McpRoutes.ts:
 * ```ts
 * router.all('/:clientName/:userId', (req, res) => {
 *   transport.handleRequest(req, res).catch(errorHandler);
 * });
 * ```
 */
export class McpStreamableTransport {
  private readonly log = defaultLogger.child({ component: 'McpStreamableTransport' });
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly config: NormalizedMcpStreamableTransportConfig;
  private readonly allowedOrigins: Set<string>;
  private readonly eventStore: InMemoryEventStore | undefined;
  private readonly requestCounter = getMcpStreamableRequestsCounter();
  private readonly latencyHistogram = getMcpStreamableLatencyHistogram();
  private readonly activeSessionsGauge = getMcpStreamableActiveSessionsGauge();

  constructor(
    private readonly mcpServer: IMcpServer,
    config?: McpStreamableTransportConfig,
    private readonly scopeGuard?: IMcpScopeGuard,
    private readonly toolPolicy?: IToolExecutionPolicy,
  ) {
    this.config = {
      maxSessions: config?.maxSessions ?? 1000,
      maxBodyBytes: config?.maxBodyBytes ?? 1_048_576, // 1 MB
      allowedOrigins: config?.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
      enableResumability: config?.enableResumability ?? false,
      resolveIdentity: config?.resolveIdentity ?? undefined,
      resolveAccessContext: config?.resolveAccessContext ?? undefined,
    };
    this.allowedOrigins = new Set(this.config.allowedOrigins);
    this.eventStore = this.config.enableResumability ? new InMemoryEventStore() : undefined;
    this.syncActiveSessionGauge();
  }

  /**
   * Handle incoming Express request per MCP Streamable HTTP spec 2025-03-26.
   *
   * - POST: JSON-RPC messages (initialize, tools/list, tools/call, ping, etc.)
   * - GET: SSE event stream for server→client notifications
   * - DELETE: Session termination
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const method = req.method?.toUpperCase();
    const metricMethod = method === 'GET' || method === 'POST' || method === 'DELETE'
      ? method
      : 'OTHER';
    const startedAt = process.hrtime.bigint();
    let result = 'ok';

    try {
      await this.withRequestContext(req, async () => {
        // ── Origin validation (DNS rebinding protection) ─────────────
        if (!this.validateOrigin(req)) {
          result = 'invalid_origin';
          this.log.warn('mcp.streamable.origin_rejected', {
            origin: req.headers.origin,
            remote: req.socket?.remoteAddress,
          });
          res.status(403).json({ error: 'Forbidden: invalid origin' });
          return;
        }

        // ── Body size limit (POST only) ─────────────────────────────
        if (method === 'POST') {
          // FIX: MCPS-H2 — Check actual body size, not just Content-Length header.
          // Chunked encoding omits Content-Length, so parseInt(undefined ?? '0') = 0 bypasses the check.
          // If body is already parsed by Express json() middleware, check the serialized size.
          const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
          const actualBodySize = req.body ? Buffer.byteLength(JSON.stringify(req.body), 'utf-8') : 0;
          const effectiveSize = Math.max(contentLength, actualBodySize);
          if (effectiveSize > this.config.maxBodyBytes) {
            result = 'payload_too_large';
            res.status(413).json({
              error: 'Payload Too Large',
              max_bytes: this.config.maxBodyBytes,
            });
            return;
          }
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const identity = this.resolveRequestIdentity(req);

        if (sessionId) {
          const existingSession = this.sessions.get(sessionId);
          if (existingSession && !this.isIdentityAuthorizedForSession(existingSession, identity)) {
            result = 'forbidden_session_identity';
            this.log.warn('mcp.streamable.identity_mismatch', {
              sessionId,
              expectedClientName: existingSession.clientName,
              expectedUserId: existingSession.userId,
              actualClientName: identity.clientName,
              actualUserId: identity.userId,
            });
            res.status(403).json({ error: 'Forbidden: session identity mismatch' });
            return;
          }
        }

        if (method === 'POST') {
          await this.handlePost(req, res, sessionId, identity);
        } else if (method === 'GET') {
          if (!sessionId || !this.sessions.has(sessionId)) {
            result = 'invalid_session';
          }
          await this.handleGet(req, res, sessionId);
        } else if (method === 'DELETE') {
          result = sessionId && this.sessions.has(sessionId)
            ? 'terminated'
            : 'session_not_found';
          await this.handleDelete(res, sessionId);
        } else {
          result = 'method_not_allowed';
          res.status(405).json({ error: 'Method Not Allowed' });
        }
      });
    } catch (error) {
      result = 'error';
      throw error;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.requestCounter.inc({ method: metricMethod, result });
      this.latencyHistogram.observe({ method: metricMethod, result }, durationSeconds);
    }
  }

  /**
   * Get count of active sessions (for monitoring).
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    const sessions = Array.from(this.sessions.entries());
    for (const [sessionId, session] of sessions) {
      await session.transport.close().catch(() => {});
      await session.server.close().catch(() => {});
      this.sessions.delete(sessionId);
    }
    this.syncActiveSessionGauge();
  }

  // ── POST: JSON-RPC messages ──────────────────────────────────

  private async handlePost(
    req: Request,
    res: Response,
    sessionId: string | undefined,
    identity: McpStreamableRequestIdentity,
  ): Promise<void> {
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    const accessContext = this.resolveRequestAccessContext(req, identity);

    if (!session) {
      // ── New session: evict stale sessions, then enforce limits ──

      const { clientName, userId } = identity;
      const trackingId = generateSecureToken(16);

      // Evict stale sessions for the same (clientName, userId) pair BEFORE limit check.
      // FIX: MCPS-RACE-01 — Previously eviction ran after the limit check, so returning
      // users with a stale session got 503 even though their old session could be freed.
      // FIX: MCPS-M11 — Collect IDs first, then delete (avoids Map mutation during iteration).
      const staleIds: string[] = [];
      for (const [existingId, existingSession] of this.sessions) {
        if (existingSession.clientName === clientName && existingSession.userId === userId) {
          staleIds.push(existingId);
        }
      }
      for (const existingId of staleIds) {
        const existingSession = this.sessions.get(existingId)!;
        this.log.info('mcp.streamable.evict_stale', { sessionId: existingId, trackingId: existingSession.trackingId });
        // FIX: MCPS-H1 — Close both transport AND server to prevent resource leak.
        await existingSession.transport.close().catch(() => {});
        await existingSession.server.close().catch(() => {});
        this.sessions.delete(existingId);
      }
      if (staleIds.length > 0) {
        this.syncActiveSessionGauge();
      }

      // Now check limit after eviction
      if (this.sessions.size >= this.config.maxSessions) {
        this.log.warn('mcp.streamable.session_limit', {
          current: this.sessions.size,
          max: this.config.maxSessions,
        });
        res.status(503).json({ error: 'Maximum session limit reached' });
        return;
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: this.eventStore,
        onsessioninitialized: (newSessionId: string) => {
          // Register session once SDK assigns the session ID
          this.sessions.set(newSessionId, managedSession);
          this.syncActiveSessionGauge();
          this.log.info('mcp.streamable.session_created', {
            sessionId: newSessionId,
            trackingId,
            clientName,
            userId,
          });
        },
      });

      const server = this.createProtocolServer(clientName, userId, trackingId);

      const managedSession: ManagedSession = {
        transport,
        server,
        clientName,
        userId,
        accessContext,
        trackingId,
        createdAt: Date.now(),
      };

      // Wire cleanup on transport close
      transport.onclose = () => {
        for (const [sid, s] of this.sessions) {
          if (s.transport === transport) {
            this.sessions.delete(sid);
            this.syncActiveSessionGauge();
            this.log.info('mcp.streamable.session_closed', { sessionId: sid, trackingId });
            break;
          }
        }
      };

      await server.connect(transport);
      session = managedSession;
    }

    await this.dispatchToSession(session, req, res, await readUnparsedJsonBody(req));
  }

  // ── GET: SSE event stream ────────────────────────────────────

  private async handleGet(req: Request, res: Response, sessionId?: string): Promise<void> {
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing Mcp-Session-Id header' });
      return;
    }

    const session = this.sessions.get(sessionId)!;
    await this.dispatchToSession(session, req, res);
  }

  private async dispatchToSession(
    session: ManagedSession,
    req: Request,
    res: Response,
    parsedBody?: unknown,
  ): Promise<void> {
    const webRequest = expressToWebRequest(req, parsedBody);
    const webResponse = await session.transport.handleRequest(
      webRequest,
      parsedBody === undefined ? undefined : { parsedBody },
    );
    if (webResponse instanceof globalThis.Response) {
      await writeWebResponse(res, webResponse);
    }
  }

  // ── DELETE: Session termination ──────────────────────────────

  private async handleDelete(res: Response, sessionId?: string): Promise<void> {
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      this.log.info('mcp.streamable.session_terminated', {
        sessionId,
        trackingId: session.trackingId,
      });
      await session.transport.close();
      await session.server.close();
      this.sessions.delete(sessionId);
      this.syncActiveSessionGauge();
      res.status(200).end();
    } else {
      // FIX: MCPS-L4 — Return 404 for non-existent sessions per MCP spec.
      // Previously returned 200 unconditionally, masking client-side bugs.
      res.status(404).json({ error: 'Session not found' });
    }
  }

  // ── Protocol Server Factory ──────────────────────────────────

  /**
   * Creates an MCP SDK Server that bridges to our Domain IMcpServer.
   * Each session gets its own Server instance for full isolation.
   */
  private createProtocolServer(clientName: string, userId: string, trackingId: string): Server {
    const server = new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      {
        capabilities: {
          tools: { listChanged: false },
          ...advertisedTaskCapabilities(this.mcpServer),
        },
      },
    );

    server.setRequestHandler('tools/list', async () => {
      const session = this.findSessionByTrackingId(trackingId);
      const tools = this.mcpServer.listTools();
      const visibleTools = session
        ? await this.filterVisibleTools(tools, session.accessContext, trackingId)
        : tools;

      return {
        tools: visibleTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      };
    });

    server.setRequestHandler('tools/call', async (request) => {
      const session = this.findSessionByTrackingId(trackingId);
      const context: McpSessionContext = {
        userId,
        clientName,
        sessionId: trackingId,
      };
      const params = request.params;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const requestMeta = this.extractMcpRequestMeta(params._meta);

      if (params.task) {
        return this.wireToolResult(this.createToolDeniedResult(
          params.name,
          'task-augmented tools/call is not supported; call run_agent and read the run with tasks/get',
        ));
      }

      if (session) {
        const accessResult = await this.evaluateToolExecution(
          request.params.name,
          args,
          session.accessContext,
          trackingId,
        );

        if (!accessResult.allowed) {
          return this.wireToolResult(accessResult.result);
        }

        return this.wireToolResult(await withMcpToolCallSpan(
          {
            toolName: params.name,
            sessionId: trackingId,
            traceparent: requestMeta.traceparent,
          },
          () => this.mcpServer.callTool(
            params.name,
            accessResult.arguments,
            context,
          ),
        ));
      }

      return this.wireToolResult(await withMcpToolCallSpan(
        {
          toolName: params.name,
          sessionId: trackingId,
          traceparent: requestMeta.traceparent,
        },
        () => this.mcpServer.callTool(
          params.name,
          args,
          context,
        ),
      ));
    });

    this.registerTaskHandlers(server, { userId, clientName, sessionId: trackingId });

    // Error handler
    server.onerror = (error: Error) => {
      this.log.error('mcp.streamable.server_error', {
        error: error.message,
        trackingId,
        clientName,
        userId,
      });
    };

    return server;
  }

  private wireToolResult(result: Awaited<ReturnType<IMcpServer['callTool']>>): {
    [key: string]: unknown;
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  } {
    return { ...result };
  }

  private extractMcpRequestMeta(rawMeta: unknown): { traceparent?: string; tracestate?: string } {
    if (!rawMeta || typeof rawMeta !== 'object') {
      return {};
    }
    const record = rawMeta as Record<string, unknown>;
    const traceparent = typeof record.traceparent === 'string' && record.traceparent.trim().length > 0
      ? record.traceparent.trim()
      : undefined;
    const tracestate = typeof record.tracestate === 'string' && record.tracestate.trim().length > 0
      ? record.tracestate.trim()
      : undefined;
    return { traceparent, tracestate };
  }

  private registerTaskHandlers(server: Server, context: McpSessionContext): void {
    if (!this.mcpServer.getTask || !this.mcpServer.cancelTask || !this.mcpServer.taskResult) return;
    const taskParams = fromJsonSchema({
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1 } },
      required: ['taskId'],
      additionalProperties: false,
    });
    const register = server.setRequestHandler.bind(server) as (
      method: string,
      schemas: { params: typeof taskParams },
      handler: (params: { taskId?: string }) => Promise<unknown>,
    ) => void;
    const missing = (taskId: string) => new ProtocolError(INVALID_PARAMS, `task ${taskId} was not found`);

    register('tasks/get', { params: taskParams }, async (params) => {
      const taskId = params.taskId ?? '';
      const task = await this.mcpServer.getTask!(taskId);
      if (!task) throw missing(taskId);
      return task;
    });
    register('tasks/cancel', { params: taskParams }, async (params) => {
      const taskId = params.taskId ?? '';
      const task = await this.mcpServer.cancelTask!(taskId, context);
      if (!task) throw missing(taskId);
      return task;
    });
    register('tasks/result', { params: taskParams }, async (params) => {
      const taskId = params.taskId ?? '';
      const task = await this.mcpServer.getTask!(taskId);
      const result = await this.mcpServer.taskResult!(taskId);
      if (!task || !result) throw missing(taskId);
      return { ...result, task };
    });
  }

  // ── Origin Validation ────────────────────────────────────────

  /**
   * Validates Origin header per MCP spec 2025-03-26 security requirements.
   * No origin header = same-origin or non-browser client (allow).
   */
  private validateOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // Non-browser clients don't send Origin
    return this.allowedOrigins.has(origin);
  }

  private resolveRequestIdentity(req: Request): McpStreamableRequestIdentity {
    const resolved = this.config.resolveIdentity?.(req) ?? {};
    return {
      clientName: resolved.clientName ?? routeParam(req.params?.clientName) ?? 'unknown',
      userId: resolved.userId ?? routeParam(req.params?.userId) ?? 'anonymous',
    };
  }

  private resolveRequestAccessContext(
    req: Request,
    identity: McpStreamableRequestIdentity,
  ): McpStreamableAccessContext {
    const resolved = this.config.resolveAccessContext?.(req) ?? {};

    return {
      agentId: resolved.agentId ?? identity.clientName,
      scopeLevel: resolved.scopeLevel ?? 'user',
      grantedScopes: resolved.grantedScopes ?? [],
    };
  }

  private isIdentityAuthorizedForSession(
    session: ManagedSession,
    identity: McpStreamableRequestIdentity,
  ): boolean {
    return session.clientName === identity.clientName && session.userId === identity.userId;
  }

  private findSessionByTrackingId(trackingId: string): ManagedSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.trackingId === trackingId) {
        return session;
      }
    }

    return undefined;
  }

  private async filterVisibleTools(
    tools: ReturnType<IMcpServer['listTools']>,
    accessContext: McpStreamableAccessContext,
    sessionId: string,
  ): Promise<ReturnType<IMcpServer['listTools']>> {
    const visibleTools: ReturnType<IMcpServer['listTools']> = [];

    for (const tool of tools) {
      if (await this.isToolVisible(tool.name, accessContext, sessionId)) {
        visibleTools.push(tool);
      }
    }

    return visibleTools;
  }

  private async isToolVisible(
    toolName: string,
    accessContext: McpStreamableAccessContext,
    sessionId: string,
  ): Promise<boolean> {
    if (this.deniesRunAgentScope(toolName, accessContext)) {
      this.log.warn('mcp.streamable.tool_hidden_by_scope', {
        toolName,
        sessionId,
        agentId: accessContext.agentId,
        scopeLevel: accessContext.scopeLevel,
        decision: 'deny',
      });
      return false;
    }

    if (this.scopeGuard) {
      const evaluation = this.scopeGuard.evaluateAccess(
        toolName,
        accessContext.scopeLevel,
        accessContext.agentId,
      );

      if (evaluation.decision !== 'allow') {
        this.log.warn('mcp.streamable.tool_hidden_by_scope', {
          toolName,
          sessionId,
          agentId: accessContext.agentId,
          scopeLevel: accessContext.scopeLevel,
          decision: evaluation.decision,
        });
        return false;
      }
    }

    if (!this.toolPolicy) {
      return true;
    }

    const policyResult = await this.toolPolicy.evaluate({
      toolName,
      arguments: {},
      agentId: accessContext.agentId,
      sessionId,
      scopeLevel: accessContext.scopeLevel,
      grantedScopes: accessContext.grantedScopes,
    });

    if (!policyResult.allowed) {
      this.log.warn('mcp.streamable.tool_hidden_by_policy', {
        toolName,
        sessionId,
        agentId: accessContext.agentId,
        scopeLevel: accessContext.scopeLevel,
        violationCode: policyResult.violationCode,
      });
      return false;
    }

    return true;
  }

  private async evaluateToolExecution(
    toolName: string,
    args: Record<string, unknown>,
    accessContext: McpStreamableAccessContext,
    sessionId: string,
  ): Promise<
    | { allowed: true; arguments: Record<string, unknown> }
    | { allowed: false; result: Awaited<ReturnType<IMcpServer['callTool']>> }
  > {
    if (this.deniesRunAgentScope(toolName, accessContext)) {
      return {
        allowed: false,
        result: this.createToolDeniedResult(toolName, `missing scope ${RUN_AGENT_REQUIRED_SCOPE}`),
      };
    }

    if (this.scopeGuard) {
      const evaluation = this.scopeGuard.evaluateAccess(
        toolName,
        accessContext.scopeLevel,
        accessContext.agentId,
      );

      if (evaluation.decision !== 'allow') {
        return {
          allowed: false,
          result: this.createToolDeniedResult(
            toolName,
            evaluation.decision === 'escalate'
              ? `scope guard requires escalation (${accessContext.scopeLevel})`
              : `scope guard denied access (${accessContext.scopeLevel})`,
          ),
        };
      }
    }

    if (!this.toolPolicy) {
      return { allowed: true, arguments: args };
    }

    const policyResult = await this.toolPolicy.evaluate({
      toolName,
      arguments: args,
      agentId: accessContext.agentId,
      sessionId,
      scopeLevel: accessContext.scopeLevel,
      grantedScopes: accessContext.grantedScopes,
    });

    if (!policyResult.allowed) {
      return {
        allowed: false,
        result: this.createToolDeniedResult(
          toolName,
          policyResult.reason ?? 'tool execution policy denied access',
        ),
      };
    }

    if (policyResult.requiresApproval) {
      return {
        allowed: false,
        result: this.createToolDeniedResult(
          toolName,
          policyResult.approvalReason ?? 'tool execution requires approval',
        ),
      };
    }

    return {
      allowed: true,
      arguments: policyResult.modifiedArguments ?? args,
    };
  }

  private deniesRunAgentScope(
    toolName: string,
    accessContext: McpStreamableAccessContext,
  ): boolean {
    return AGENT_RUN_SCOPE_TOOLS.has(toolName)
      && !accessContext.grantedScopes.includes(RUN_AGENT_REQUIRED_SCOPE);
  }

  private createToolDeniedResult(
    toolName: string,
    reason: string,
  ): Awaited<ReturnType<IMcpServer['callTool']>> {
    return {
      content: [{ type: 'text', text: `MCP tool "${toolName}" denied: ${reason}` }],
      isError: true,
    };
  }

  private syncActiveSessionGauge(): void {
    this.activeSessionsGauge.set(this.sessions.size);
  }

  private async withRequestContext<T>(req: Request, fn: () => Promise<T>): Promise<T> {
    if (AsyncLocalRequestContext.getCurrent()) {
      return fn();
    }

    const contextData = RequestContextFactory.fromHttpRequest(req);
    return AsyncLocalRequestContext.runWith(contextData, fn);
  }
}
