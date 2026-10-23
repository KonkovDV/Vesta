/**
 * Bootstrap Orchestrator
 * Layer: Core
 *
 * Назначение:
 * - Координация инициализации слоев: Infrastructure → Application → Presentation (HTTP)
 * - Исключение прямых зависимостей Infrastructure от Domain/Application/Presetation кодов в bootstrap
 *
 * Стандартный порядок:
 *  1) bootstrapInfrastructureServices: DB, Cache, Storage, Event Store/Bus, Outbox, Repositories
 *  2) bootstrapApplicationServices: Use Cases, Application Services (использует уже зарегистрированные инфраструктурные токены)
 *  3) bootstrapPresentationServices: запуск HTTP сервера (Express) Application-слоя
 */

import { container } from '../di/container';
import type { IHttpServer } from '../contracts/IHttpServer';
import type { IAppFactory } from '../contracts/IAppFactory';
import { AspectManager } from '../aop/AspectManager';
import aspectConfig from '../aop/aspect-config';
import { getConfig } from '../../config';

interface CloseableResource {
  close(): Promise<void>;
}

interface FlushableResource {
  flush(): Promise<void>;
}

interface StoppableResource {
  stop(): Promise<void> | void;
}

interface DisposableResource {
  dispose(): Promise<void> | void;
}

type GracefulSessionStore = Partial<CloseableResource & FlushableResource>;
type ShutdownCapableResource = Partial<StoppableResource & CloseableResource & DisposableResource>;
type ShutdownToken = string | symbol;

// Metrics server reference for lifecycle management
let metricsServerInstance: { stop(): Promise<void> } | null = null;

async function invokeShutdownHook(resource: ShutdownCapableResource): Promise<boolean> {
  if (typeof resource.stop === 'function') {
    await resource.stop();
    return true;
  }

  if (typeof resource.close === 'function') {
    await resource.close();
    return true;
  }

  if (typeof resource.dispose === 'function') {
    await resource.dispose();
    return true;
  }

  return false;
}

async function shutdownRemainingSingletons(skipTokens: ReadonlySet<ShutdownToken>): Promise<void> {
  const remainingSingletons = container
    .getAllServices()
    .filter((service) => service.lifecycle === 'singleton')
    .filter((service) => !skipTokens.has(service.token))
    .filter((service) => container.isInstantiated(service.token))
    .reverse();

  for (const service of remainingSingletons) {
    try {
      if (!container.isRegistered(service.token) || !container.isInstantiated(service.token)) {
        continue;
      }

      const instance = container.resolve<ShutdownCapableResource>(service.token);
      const handled = await invokeShutdownHook(instance);
      if (handled) {
        process.stdout.write(`✓ ${String(service.token)} shutdown hook completed\n`);
      }
    } catch (err) {
      process.stderr.write(`❌ Failed to shutdown ${String(service.token)}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    }
  }
}

/**
 * Infrastructure bootstrap function signature.
 * Implemented by Infrastructure layer, injected by entry point.
 */
export type InfrastructureBootstrapFn = (config: {
  initTimeoutMs?: number;
  logInitialization?: boolean;
  environment?: 'production' | 'development' | 'test';
  useInMemoryRepositories?: boolean;
}) => Promise<typeof container>;

export interface OrchestratorOptions {
  infrastructure?: {
    initTimeoutMs?: number;
    logInitialization?: boolean;
    /** Infrastructure bootstrap function - must be provided by entry point */
    bootstrapFn?: InfrastructureBootstrapFn;
  };
  application?: {
    logInitialization?: boolean;
    force?: boolean;
  };
  presentation?: {
    enableHttp?: boolean; // default: true
    port?: number;        // если указан, переопределяет PORT из конфигурации
    logStart?: boolean;   // default: true
  };
}

export async function bootstrapInfrastructureServices(
  options?: OrchestratorOptions['infrastructure']
): Promise<typeof container> {
  if (!options?.bootstrapFn) {
    throw new Error(
      '[Orchestrator] Infrastructure bootstrap function not provided. ' +
        'Callers must provide infrastructure.bootstrapFn from the Infrastructure layer.'
    );
  }

  const cfg = {
    initTimeoutMs: options?.initTimeoutMs ?? 30000,
    logInitialization: options?.logInitialization ?? true,
  };
  // Делегируем реальную регистрацию инфраструктуры через переданную функцию
  const c = await options.bootstrapFn(cfg);
  return c;
}

export async function bootstrapApplicationLayer(
  options?: OrchestratorOptions['application']
): Promise<void> {
  // Application services уже регистрируются внутри инфраструктурного bootstrap()
  // в соответствии с архитектурными правилами; здесь ничего дополнительно не делаем,
  // но гарантируем, что фабрика HTTP-приложения доступна через DI-токен 'AppFactory'.
  const appFactory = container.resolve<IAppFactory>('AppFactory');

  if (options?.logInitialization !== false) {
     
    console.log('[Orchestrator] Application layer registered (no-op: handled by infra bootstrap)');
    if (typeof appFactory.createApp !== 'function') {
       
      console.warn('[Orchestrator] Resolved AppFactory does not expose createApp() method');
    }
  }
}

export async function bootstrapPresentationServices(
  options?: OrchestratorOptions['presentation']
): Promise<{ app: unknown; port: number } | null> {
  const enable = options?.enableHttp ?? true;
  if (!enable) {
    return null;
  }

  const configSnapshot = getConfig();
  const portFromOptions =
    typeof options?.port === 'number' && Number.isFinite(options.port)
      ? options.port
      : undefined;
  const port =
    portFromOptions ??
    (typeof configSnapshot.PORT === 'number' && Number.isFinite(configSnapshot.PORT)
      ? configSnapshot.PORT
      : 3000);

  const httpServer = container.resolve<IHttpServer>('HttpServer');
  const { app, port: actualPort } = await httpServer.start({
    port,
    logStart: options?.logStart,
  });

  return { app, port: actualPort };
}

/**
 * Полный bootstrap приложения
 * - Infrastructure → Application → Presentation(HTTP)
 */
export async function bootstrapApplication(
  opts?: OrchestratorOptions
): Promise<{ app: unknown; port: number } | null> {
  const startedAt = process.hrtime.bigint();

  // Validate bootstrapFn is provided
  if (!opts?.infrastructure?.bootstrapFn) {
    throw new Error(
      '[Orchestrator] Infrastructure bootstrap function not provided. ' +
        'Callers must provide infrastructure.bootstrapFn from the Infrastructure layer.'
    );
  }

  // 1) Infra + application services via canonical infra bootstrap
  await opts.infrastructure.bootstrapFn(opts.infrastructure);

  if (aspectConfig?.aspects?.length) {
    try {
      const manager = new AspectManager(container);
      // @audit-ok: startup-only — aspect registration runs once
      for (const registration of aspectConfig.aspects) {
        try {
          manager.registerAspect(registration);
          console.log(`✅ Aspect registered: ${registration.name || 'unnamed'}`);
        } catch (aspectError) {
          console.error(`❌ Failed to register aspect:`, {
            name: registration.name,
            error: aspectError instanceof Error ? aspectError.message : String(aspectError),
            stack: aspectError instanceof Error ? aspectError.stack : undefined
          });
          // Продолжаем bootstrap даже если один aspect упал
        }
      }
      container.setAspectManager(manager);
      console.log(`✅ AspectManager initialized with ${aspectConfig.aspects.length} aspects`);
    } catch (error) {
      console.error('❌ Failed to initialize AspectManager:', error instanceof Error ? error.message : String(error));
      // Не прерываем весь bootstrap из-за ошибок в AOP
    }
  }

  // 2) Application
  await bootstrapApplicationLayer(opts?.application);

  // 3) Presentation (HTTP)
  const http = await bootstrapPresentationServices(opts?.presentation);

  // 4) Metrics server on separate port (CNCF best practice)
  // Resolved via DI — registered in http.module.ts (Infrastructure layer)
  try {
    if (container.isRegistered('MetricsServer')) {
      const metricsServer = container.resolve<{ start(): Promise<number>; stop(): Promise<void> }>('MetricsServer');
      await metricsServer.start();
      metricsServerInstance = metricsServer;
    }
  } catch (err) {
    console.warn('[Orchestrator] Metrics server failed to start (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  const durMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
   
  console.log(`[Orchestrator] Bootstrap completed in ${durMs.toFixed(2)}ms`);

  return http;
}

/**
 * Canonical graceful shutdown — dependency-aware ordering.
 *
 * Shutdown sequence follows reverse-dependency order:
 *   1. Stop intake (HTTP, metrics) — no new requests
 *   2. Flush Outbox while EventBus + EventStore are still alive
 *   3. Close EventBus (no more publish)
 *   4. Close EventStore (no more persistence)
 *   5. Close remaining session stores
 *   6. Clear DI container
 *
 * Critical invariant: Outbox.processPendingMessages() calls EventBus.publish(),
 * therefore EventBus MUST remain open until outbox flush completes.
 * See: KNOWN_BUGS.md — SHUTDOWN-ORDER-001.
 */
export async function shutdownApplication(): Promise<void> {
  console.log('🛑 Starting graceful shutdown...');
  const handledTokens = new Set<ShutdownToken>();

  try {
    // Phase 1: Stop intake — no new connections or metric scrapes
    if (metricsServerInstance) {
      try {
        await metricsServerInstance.stop();
        metricsServerInstance = null;
        handledTokens.add('MetricsServer');
      } catch (err) {
        console.error('❌ Failed to stop metrics server:', err);
      }
    }

    if (container.isRegistered('HttpServer') && container.isInstantiated('HttpServer')) {
      try {
        const httpServer = container.resolve<IHttpServer>('HttpServer');
        await httpServer.stop();
        handledTokens.add('HttpServer');
      } catch (err) {
        console.error('❌ Failed to stop HTTP server:', err);
      }
    }

    // Phase 2: Flush Outbox WHILE EventBus + EventStore are still alive
    // processPendingMessages() → eventBus.publish() → markMessagePublished()
    if (container.isRegistered('IOutbox') && container.isInstantiated('IOutbox')) {
      try {
        const outbox = container.resolve<FlushableResource & CloseableResource & { processPendingMessages?(batchSize?: number): Promise<unknown> }>('IOutbox');
        if (typeof outbox.processPendingMessages === 'function') {
          await outbox.processPendingMessages();
          console.log('✓ Outbox pending messages flushed');
        }
        if (outbox.close) await outbox.close();
        handledTokens.add('IOutbox');
      } catch (err) {
        console.error('❌ Failed to flush/close Outbox:', err);
      }
    }

    // Phase 3: Close EventBus (after outbox flush — no more publish needed)
    if (container.isRegistered('IEventBus') && container.isInstantiated('IEventBus')) {
      try {
        const eventBus = container.resolve<CloseableResource>('IEventBus');
        if (eventBus.close) await eventBus.close();
        handledTokens.add('IEventBus');
      } catch (err) {
        console.error('❌ Failed to close EventBus:', err);
      }
    }

    // Phase 4: Close EventStore (after EventBus — no more persistence needed)
    if (container.isRegistered('IEventStore') && container.isInstantiated('IEventStore')) {
      try {
        const eventStore = container.resolve<CloseableResource>('IEventStore');
        if (eventStore.close) await eventStore.close();
        handledTokens.add('IEventStore');
      } catch (err) {
        console.error('❌ Failed to close EventStore:', err);
      }
    }

    // Phase 5: Close session stores and remaining resources
    if (container.isRegistered('IMasSessionStore') && container.isInstantiated('IMasSessionStore')) {
      try {
        const masSessionStore = container.resolve<GracefulSessionStore>('IMasSessionStore');
        if (masSessionStore.flush) await masSessionStore.flush();
        if (masSessionStore.close) await masSessionStore.close();
        handledTokens.add('IMasSessionStore');
      } catch (err) {
        console.error('❌ Failed to close MAS session store:', err);
      }
    }

    // Phase 5.5: Close database connection pool
    // Prevents lingering connections that cause Postgres "terminating connection" errors
    if (container.isRegistered('IDatabaseConnection') && container.isInstantiated('IDatabaseConnection')) {
      try {
        const dbPool = container.resolve<CloseableResource>('IDatabaseConnection');
        if (dbPool.close) await dbPool.close();
        console.log('✓ Database connection pool closed');
        handledTokens.add('IDatabaseConnection');
      } catch (err) {
        console.error('❌ Failed to close database pool:', err);
      }
    }

    // Phase 6: Close any remaining instantiated singleton resources
    await shutdownRemainingSingletons(handledTokens);

    // Phase 7: Clear DI container
    container.clear();
    console.log('✅ Graceful shutdown completed');
  } catch (error) {
    console.error('❌ Graceful shutdown failed:', error);
    throw error;
  }
}

export default {
  bootstrapInfrastructureServices,
  bootstrapApplicationLayer,
  bootstrapPresentationServices,
  bootstrapApplication,
};