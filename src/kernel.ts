/**
 * Public entry of the MicroPhoenix kernel.
 *
 * A project built on the kernel depends on this package and calls `runKernel()`
 * with its extensions. Importing this module starts nothing: the server, the
 * telemetry SDK and the process handlers start inside `runKernel()`.
 *
 * Entry chain: src/index.ts → src/kernel.ts → core/bootstrap/orchestrator.ts
 * → infrastructure/di/bootstrap.ts → application/app.ts.
 */
import path from 'node:path';

import type { HttpRouteRegistrar } from './application/app';
import type { DIContainer } from './core/di/container';

export * from './ai-types';
export type { HttpRouteRegistrar, HttpRouteRegistrationContext } from './application/app';
export type { DIContainer } from './core/di/container';
export {
  CORE_MIGRATIONS_DIR,
  listMigrationFiles,
  runMigrations,
} from './infrastructure/database/migration-runner';
export type { MigrationClient, MigrationRunResult } from './infrastructure/database/migration-runner';
export type {
  IToolExecutionPolicy,
  ToolExecutionRequest,
  ToolPolicyResult,
} from './domain/security/tool-execution-policy.interface';
export type {
  CronJob,
  ICronJobRepository,
  ICronService,
} from './domain/scheduling/cron-service.port';

export interface KernelExtension {
  readonly name: string;
  /**
   * Runs after the kernel's DI bootstrap and before the HTTP app is built.
   * Register new tokens only: a token the kernel already registered throws.
   */
  register?(container: DIContainer): void | Promise<void>;
  /** Mounted after the kernel routes and before the 404 handler. */
  readonly routes?: HttpRouteRegistrar;
  /** Applied after kernel migrations: `microphoenix-migrate --dir <migrationsDir>`. */
  readonly migrationsDir?: string;
}

/** Startup failed before the server was listening. The process is still running. */
export class KernelStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelStartError';
  }
}

export interface KernelOptions {
  readonly extensions?: readonly KernelExtension[];
  /** SIGTERM/SIGINT shutdown and crash handlers. Default true. */
  readonly processHandlers?: boolean;
}

const ROUTE_REGISTRAR_TOKEN = 'HttpRouteRegistrar';

export function extensionMigrationDirs(extensions: readonly KernelExtension[]): string[] {
  return extensions
    .map((extension) => extension.migrationsDir)
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
    .map((dir) => path.resolve(dir));
}

export async function applyKernelExtensions(
  container: DIContainer,
  extensions: readonly KernelExtension[],
): Promise<void> {
  const names = new Set<string>();
  extensions.forEach((extension) => {
    if (extension.name.trim().length === 0) {
      throw new Error('Kernel extension name is empty');
    }
    if (names.has(extension.name)) {
      throw new Error(`Kernel extension "${extension.name}" is listed twice`);
    }
    names.add(extension.name);
  });

  await extensions.reduce(async (previous, extension) => {
    await previous;
    await extension.register?.(container);
  }, Promise.resolve());

  const routes = extensions
    .map((extension) => extension.routes)
    .filter((registrar): registrar is HttpRouteRegistrar => typeof registrar === 'function');
  if (routes.length === 0) {
    return;
  }

  const kernelRoutes = container.isRegistered(ROUTE_REGISTRAR_TOKEN)
    ? container.resolve<HttpRouteRegistrar>(ROUTE_REGISTRAR_TOKEN)
    : undefined;
  container.unregister(ROUTE_REGISTRAR_TOKEN);
  const composed: HttpRouteRegistrar = (app, context) => {
    kernelRoutes?.(app, context);
    routes.forEach((register) => {
      register(app, context);
    });
  };
  container.register<HttpRouteRegistrar>(ROUTE_REGISTRAR_TOKEN, () => composed, {
    lifecycle: 'singleton',
    tags: ['http'],
    description: 'Kernel routes followed by extension routes',
  });
}

let processHandlersInstalled = false;

interface KernelProcessHandlers {
  sigterm: () => void;
  sigint: () => void;
  uncaught: (error: Error) => void;
  rejection: (reason: unknown) => void;
}

let kernelProcessHandlers: KernelProcessHandlers | null = null;

function detachKernelProcessHandlers(): void {
  if (kernelProcessHandlers) {
    process.off('SIGTERM', kernelProcessHandlers.sigterm);
    process.off('SIGINT', kernelProcessHandlers.sigint);
    process.off('uncaughtException', kernelProcessHandlers.uncaught);
    process.off('unhandledRejection', kernelProcessHandlers.rejection);
    kernelProcessHandlers = null;
  }
  processHandlersInstalled = false;
}

/** Graceful shutdown must finish before the orchestrator's grace period (k8s: 60 s). */
const SHUTDOWN_TIMEOUT_MS = 45_000;

function flushWritableStream(stream: NodeJS.WriteStream, timeoutMs = 1000): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.off('drain', finish);
      stream.off('error', finish);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    timeout.unref?.();
    stream.once('error', finish);
    try {
      if (!stream.write('')) {
        stream.once('drain', finish);
        return;
      }
      finish();
    } catch {
      finish();
    }
  });
}

async function flushProcessStreams(): Promise<void> {
  await Promise.allSettled([flushWritableStream(process.stdout), flushWritableStream(process.stderr)]);
}

async function installProcessHandlers(): Promise<void> {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  const { shutdownApplication } = await import('./core/bootstrap/orchestrator');
  const { shutdownTelemetry } = await import('./infrastructure/telemetry/instrumentation');
  const { StructuredLogger } = await import('./infrastructure/logging/StructuredLogger');

  let isShuttingDown = false;
  const handleShutdownSignal = (signal: string): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[EntryPoint] Received ${signal}, starting graceful shutdown...`);
    const forceExitTimer = setTimeout(() => {
      console.error(`[EntryPoint] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    shutdownApplication()
      .then(() => shutdownTelemetry())
      .then(async () => {
        console.log('[EntryPoint] Graceful shutdown completed');
        process.exitCode = 0;
        await flushProcessStreams();
        process.exit(0);
      })
      .catch(async (err) => {
        console.error('[EntryPoint] Shutdown error:', err);
        process.exitCode = 1;
        await flushProcessStreams();
        process.exit(1);
      });
  };

  const sigterm = function handleKernelSigterm() { handleShutdownSignal('SIGTERM'); };
  const sigint = function handleKernelSigint() { handleShutdownSignal('SIGINT'); };
  const uncaught = (error: Error): void => {
    StructuredLogger.captureExternalError({
      message: '[EntryPoint] FATAL: Uncaught exception',
      logger: 'EntryPoint',
      error,
      captureKind: 'uncaughtException',
    });
    console.error('[EntryPoint] FATAL: Uncaught exception — process will exit', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500);
  };
  const rejection = (reason: unknown): void => {
    StructuredLogger.captureExternalError({
      message: '[EntryPoint] FATAL: Unhandled promise rejection',
      logger: 'EntryPoint',
      error: reason instanceof Error ? reason : { name: 'UnhandledRejection', message: String(reason) },
      captureKind: 'unhandledRejection',
    });
    console.error('[EntryPoint] FATAL: Unhandled promise rejection — process will exit', {
      reason: reason instanceof Error
        ? { name: reason.name, message: reason.message, stack: reason.stack }
        : String(reason),
    });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500);
  };

  kernelProcessHandlers = { sigterm, sigint, uncaught, rejection };
  process.on('SIGTERM', sigterm);
  process.on('SIGINT', sigint);
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', rejection);
}

function flagEnabled(raw: unknown, fallback: boolean, enabledValue: 'true' | 'not-false'): boolean {
  if (typeof raw !== 'string') return fallback;
  const value = raw.toLowerCase();
  return enabledValue === 'true' ? value === 'true' : value !== 'false';
}

export async function runKernel(options: KernelOptions = {}): Promise<{ app: unknown; port: number } | null> {
  const extensions = options.extensions ?? [];
  const installHandlers = options.processHandlers !== false && !processHandlersInstalled;
  if (options.processHandlers !== false) {
    await installProcessHandlers();
  }

  try {
    // Must run before Express, pg and Redis load so auto-instrumentation can patch them.
    const { initTelemetry } = await import('./infrastructure/telemetry/instrumentation');
    await initTelemetry();

    const { getConfig, getRawEnv } = await import('./config');
    if (getRawEnv().SKIP_INTEGRITY_CHECKS === 'true') {
      console.warn('[EntryPoint] WARNING: System integrity checks skipped (SKIP_INTEGRITY_CHECKS=true)');
    } else {
      console.log('[EntryPoint] PHASE 0: Running System Integrity Checks...');
      const { runBootstrapChecks } = await import('./core/bootstrap/bootstrap-orchestrator');
      const integrityResult = await runBootstrapChecks();
      if (!integrityResult.canContinue) {
        throw new KernelStartError(
          `System integrity checks failed: ${integrityResult.criticalFailures.join(', ')}`,
        );
      }
      if (integrityResult.warnings.length > 0) {
        console.warn('[EntryPoint] System integrity warnings:', integrityResult.warnings.join(', '));
      }
    }

    const config = getConfig();
    const { safeParseInt } = await import('./core/config/safe-parse');
    const { bootstrapApplication } = await import('./core/bootstrap/orchestrator');
    const { bootstrap: infrastructureBootstrap } = await import('./infrastructure/di/bootstrap');

    const result = await bootstrapApplication({
      infrastructure: {
        initTimeoutMs: safeParseInt(config.INFRA_INIT_TIMEOUT_MS, 30000),
        logInitialization: flagEnabled(config.INFRA_LOG_INIT, true, 'not-false'),
        bootstrapFn: async (bootstrapConfig) => {
          const container = await infrastructureBootstrap(bootstrapConfig);
          await applyKernelExtensions(container, extensions);
          return container;
        },
      },
      application: {
        logInitialization: flagEnabled(config.APP_LOG_INIT, true, 'not-false'),
        force: flagEnabled(config.APP_BOOTSTRAP_FORCE, false, 'true'),
      },
      presentation: {
        enableHttp: flagEnabled(config.ENABLE_HTTP, true, 'not-false'),
        port: typeof config.PORT === 'number' ? config.PORT : undefined,
        logStart: flagEnabled(config.HTTP_LOG_START, true, 'not-false'),
      },
    });

    if (result) {
      console.log(`[EntryPoint] HTTP server running on port ${result.port}`);
    } else {
      console.log('[EntryPoint] Application bootstrapped without HTTP server');
    }
    return result;
  } catch (err) {
    if (installHandlers) {
      detachKernelProcessHandlers();
    }
    if (err instanceof KernelStartError) {
      throw err;
    }
    throw new KernelStartError(err instanceof Error ? err.message : String(err));
  }
}
