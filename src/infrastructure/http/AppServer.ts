import type { Server } from 'http';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IAppFactory } from '../../core/contracts/IAppFactory';
import type {
  IHttpServer,
  HttpServerStartOptions,
  HttpServerStartResult,
} from '../../core/contracts/IHttpServer';

/**
 * Инфраструктурный HTTP сервер, отвечающий за старт/остановку Express-приложения.
 * Реализация не зависит от конкретных маршрутов/контроллеров: они формируются
 * в application-слое и поставляются через IAppFactory.
 */
export class AppServer implements IHttpServer {
  private readonly appFactory: IAppFactory;
  private readonly logger?: ILogger;
  private server: Server | null = null;
  private currentApp: unknown;

  constructor(appFactory: IAppFactory, logger?: ILogger) {
    this.appFactory = appFactory;
    this.logger = logger;
  }

  public async start(options: HttpServerStartOptions): Promise<HttpServerStartResult> {
    if (this.server) {
      throw new Error('[AppServer] HTTP server already started');
    }

    const { app } = await this.appFactory.createApp();
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
