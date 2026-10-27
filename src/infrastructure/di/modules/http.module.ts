/**
 * HTTP server DI module.
 */
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { IAppFactory } from '../../../core/contracts/IAppFactory';
import type { IHttpServer } from '../../../core/contracts/IHttpServer';
import { AppServer } from '../../http/AppServer';
import { MetricsServer } from '../../http/MetricsServer';

export const HTTP_SERVER_TOKEN = 'HttpServer';
export const METRICS_SERVER_TOKEN = 'MetricsServer';

export function registerHttpModule(): void {
  if (container.isRegistered(HTTP_SERVER_TOKEN)) {
    return;
  }

  container.register<IHttpServer>(
    HTTP_SERVER_TOKEN,
    (c) => {
      const appFactory = c.resolve<IAppFactory>(DI_TOKENS.AppFactory);
      const logger = c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : undefined;
      return new AppServer(appFactory, logger);
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
