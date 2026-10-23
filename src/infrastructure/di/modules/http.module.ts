/**
 * HTTP server DI module.
 */
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { IAppFactory } from '../../../core/contracts/IAppFactory';
import type { IHttpServer } from '../../../core/contracts/IHttpServer';
import type { AuthService } from '../../../application/services/AuthService';
import type { IMcpServer } from '../../../domain/mcp/IMcpServer';
import type { IMcpScopeGuard } from '../../../domain/mcp/IMcpScopeGuard';
import type { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';
import { AppServer } from '../../http/AppServer';
import { MetricsServer } from '../../http/MetricsServer';

export const HTTP_SERVER_TOKEN = 'HttpServer';
export const METRICS_SERVER_TOKEN = 'MetricsServer';

function resolveOptionalToken<T>(
  resolver: { isRegistered(token: string): boolean; resolve<U>(token: string): U },
  tokens: readonly string[],
): T | undefined {
  for (const token of tokens) {
    if (resolver.isRegistered(token)) {
      return resolver.resolve<T>(token);
    }
  }

  return undefined;
}

export function registerHttpModule(): void {
  if (container.isRegistered(HTTP_SERVER_TOKEN)) {
    return;
  }

  container.register<IHttpServer>(
    HTTP_SERVER_TOKEN,
    (c) => {
      const appFactory = c.resolve<IAppFactory>(DI_TOKENS.AppFactory);
      const logger = c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : undefined;
      const mcpServer = c.isRegistered(DI_TOKENS.IMcpServer)
        ? c.resolve<IMcpServer>(DI_TOKENS.IMcpServer)
        : undefined;
      const authService = resolveOptionalToken<AuthService>(c, ['authService', 'AuthService']);
      const mcpScopeGuard = c.isRegistered(DI_TOKENS.IMcpScopeGuard)
        ? c.resolve<IMcpScopeGuard>(DI_TOKENS.IMcpScopeGuard)
        : undefined;
      const toolExecutionPolicy = resolveOptionalToken<IToolExecutionPolicy>(c, [
        DI_TOKENS.IToolExecutionPolicy,
        'IToolExecutionPolicy',
      ]);
      return new AppServer(
        appFactory,
        logger,
        mcpServer,
        authService,
        mcpScopeGuard,
        toolExecutionPolicy,
      );
    },
    {
      lifecycle: 'singleton',
      tags: ['http', 'server', 'infrastructure'],
      description: 'Express HTTP server wrapper (AppServer) registered for orchestrator',
    },
  );

  container.register<MetricsServer>(
    METRICS_SERVER_TOKEN,
    () => new MetricsServer(),
    {
      lifecycle: 'singleton',
      tags: ['http', 'metrics', 'infrastructure'],
      description: 'Dedicated Prometheus metrics HTTP server on separate port (CNCF best practice)',
    },
  );
}
