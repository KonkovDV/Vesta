import type { Server } from 'http';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IAppFactory } from '../../core/contracts/IAppFactory';
import type {
  IHttpServer,
  HttpServerStartOptions,
  HttpServerStartResult,
} from '../../core/contracts/IHttpServer';
import { createMcpAuthMiddleware, type HttpRequestAuthenticator } from './mcp-auth';
import type { IMcpServer } from '../../domain/mcp/IMcpServer';
import type { IMcpScopeGuard } from '../../domain/mcp/IMcpScopeGuard';
import type { IToolExecutionPolicy } from '../../domain/security/tool-execution-policy.interface';
import { routeParam } from '../../core/http/route-param';
import { createMcpRoutes } from '../mcp/McpRoutes';
import { McpStreamableTransport } from '../mcp/McpStreamableTransport';

/** Agent id for tool policy on the MCP HTTP server: not taken from the request. */
export const MCP_HTTP_AGENT_ID = 'mcp-http-client';

type ExpressLikeApp = {
  use: (...args: Array<unknown>) => unknown;
  listen: (...args: Array<unknown>) => Server;
};

/**
 * Инфраструктурный HTTP сервер, отвечающий за старт/остановку Express-приложения.
 * Реализация не зависит от конкретных маршрутов/контроллеров: они формируются
 * в application-слое и поставляются через IAppFactory.
 */
export class AppServer implements IHttpServer {
  private readonly appFactory: IAppFactory;
  private readonly logger?: ILogger;
  private readonly mcpServer?: IMcpServer;
  private readonly authenticator?: HttpRequestAuthenticator;
  private readonly mcpScopeGuard?: IMcpScopeGuard;
  private readonly toolExecutionPolicy?: IToolExecutionPolicy;
  private server: Server | null = null;
  private currentApp: unknown;
  private mcpTransport?: McpStreamableTransport;
  private mcpMounted = false;

  constructor(
    appFactory: IAppFactory,
    logger?: ILogger,
    mcpServer?: IMcpServer,
    authenticator?: HttpRequestAuthenticator,
    mcpScopeGuard?: IMcpScopeGuard,
    toolExecutionPolicy?: IToolExecutionPolicy,
  ) {
    this.appFactory = appFactory;
    this.logger = logger;
    this.mcpServer = mcpServer;
    this.authenticator = authenticator;
    this.mcpScopeGuard = mcpScopeGuard;
    this.toolExecutionPolicy = toolExecutionPolicy;
  }

  public async start(options: HttpServerStartOptions): Promise<HttpServerStartResult> {
    if (this.server) {
      throw new Error('[AppServer] HTTP server already started');
    }

    const { app } = await this.appFactory.createApp();
  this.mountMcpRoutes(app);
    const server = await this.listen(app, options);

    // Slowloris / Slow HTTP attack protection (OWASP)
    server.headersTimeout = 30_000;  // 30s — max time to receive complete headers
    server.requestTimeout = 120_000; // 2min — max time for entire request
    // keepAliveTimeout must exceed reverse proxy idle timeout (AWS ALB: 60s, nginx: 60s)
    // to prevent 502 errors from proxy reusing a connection that Node already closed
    server.keepAliveTimeout = 65_000; // 65s — 5s margin above typical proxy defaults

    this.server = server;
    this.currentApp = app;

    const resolvedPort = this.resolvePort(server, options.port);
    const host = options.host ?? '0.0.0.0';

    if (options.logStart !== false) {
      this.log('info', 'http_server_started', { port: resolvedPort, host });
    }

    return { port: resolvedPort, app };
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const serverToClose = this.server;
    this.server = null;

    // Drain idle keep-alive connections before closing (Node 18.2+)
    // Prevents connections held open past terminationGracePeriodSeconds
    serverToClose.closeIdleConnections();

    await new Promise<void>((resolve, reject) => {
      serverToClose.close((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    if (this.mcpTransport) {
      await this.mcpTransport.close();
      this.mcpTransport = undefined;
    }
    this.mcpMounted = false;

    if (this.logger?.info) {
      this.logger.info('http_server_stopped');
    } else {
      console.log('[AppServer] HTTP server stopped');
    }

    this.currentApp = undefined;
  }

  public isRunning(): boolean {
    return this.server !== null;
  }

  private listen(app: unknown, options: HttpServerStartOptions): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const rawApp = app as { listen: (...args: Array<unknown>) => Server };

      const onError = (error: unknown) => {
        server?.off?.('error', onError);
        this.log('error', 'http_server_listen_failed', {
          port: options.port,
          host: options.host,
          error: error instanceof Error ? error.message : String(error),
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const onListening = () => {
        server?.off?.('error', onError);
        resolve(server);
      };

      const listenArgs: Array<unknown> = [options.port];
      if (options.host) {
        listenArgs.push(options.host);
      }
      listenArgs.push(onListening);

      const server = rawApp.listen(...listenArgs);
      server.once('error', onError);
    });
  }

  private mountMcpRoutes(app: unknown): void {
    const expressApp = this.asExpressLikeApp(app);
    if (!expressApp || !this.mcpServer || this.mcpMounted) {
      return;
    }

    if (!this.authenticator) {
      this.log('error', 'mcp_http_routes_not_mounted', { reason: 'authService missing' });
      return;
    }

    this.mcpTransport = new McpStreamableTransport(
      this.mcpServer,
      {
        resolveIdentity: (req) => {
          const authenticatedRequest = req as {
            authContext?: { userId?: string; scopes?: string[] };
            user?: { id?: string };
          };
          return {
            clientName: routeParam(req.params?.clientName),
            userId: authenticatedRequest.authContext?.userId ?? authenticatedRequest.user?.id,
          };
        },
        resolveAccessContext: (req) => {
          const authenticatedRequest = req as { authContext?: { scopes?: string[] } };
          return {
            // The tool profile is chosen by agent id (researcher-* gets 'full'). The
            // client names the URL segment, so it must not become the agent id.
            agentId: MCP_HTTP_AGENT_ID,
            scopeLevel: authenticatedRequest.authContext ? 'user' : 'project',
            grantedScopes: authenticatedRequest.authContext?.scopes ?? [],
          };
        },
      },
      this.mcpScopeGuard,
      this.toolExecutionPolicy,
    );

    const routeMiddleware = [createMcpAuthMiddleware(this.authenticator)];

    expressApp.use('/api/mcp', ...routeMiddleware, createMcpRoutes(this.mcpTransport, this.logger));
    this.mcpMounted = true;
    this.log('info', 'mcp_http_routes_mounted', { basePath: '/api/mcp' });
  }

  private asExpressLikeApp(app: unknown): ExpressLikeApp | undefined {
    if (!app || typeof app !== 'function') {
      return undefined;
    }

    const candidate = app as Partial<ExpressLikeApp>;
    if (typeof candidate.use !== 'function' || typeof candidate.listen !== 'function') {
      return undefined;
    }

    return candidate as ExpressLikeApp;
  }

  private resolvePort(server: Server, fallbackPort: number): number {
    const address = server.address();
    if (!address) {
      return fallbackPort;
    }
    if (typeof address === 'string') {
      return fallbackPort;
    }
    return typeof address.port === 'number' ? address.port : fallbackPort;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    if (!this.logger) {
      const payload = meta ? `${message} ${JSON.stringify(meta)}` : message;
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[*] ${payload}`);
      return;
    }

    const loggerMethod = this.logger[level] ?? this.logger.log;
    if (typeof loggerMethod === 'function') {
      loggerMethod.call(this.logger, message, meta ?? {});
    }
  }
}
