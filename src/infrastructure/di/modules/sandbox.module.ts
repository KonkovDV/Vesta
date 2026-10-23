/**
 * Sandbox DI Module
 * Registers sandbox execution services and pool management.
 * Layer: Infrastructure/DI
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { ISandboxedExecutor } from '../../../domain/sandbox/sandboxed-executor.port';
import { GVisorExecutor } from '../../sandbox/gvisor-executor';
import { SeccompExecutor } from '../../sandbox/seccomp-executor';
import { SandboxPool } from '../../sandbox/sandbox-pool';
import { getConfig } from '../../../config';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { MxcProcessContainer } from '../../platform/MxcProcessContainer';
import type { IPlatformAdapter } from '../../../domain/platform/IPlatformAdapter';

export type SandboxProvider = 'gvisor' | 'seccomp' | 'auto';

export interface SandboxModuleConfig {
  provider: SandboxProvider;
  poolSize: {
    min: number;
    max: number;
  };
  defaultLimits: {
    timeoutMs: number;
    memoryLimitMb: number;
  };
}

let sandboxPoolInstance: SandboxPool | null = null;
const log = getBootstrapLogger('sandbox');

/**
 * Creates the appropriate executor based on configuration
 */
function createExecutorSync(provider: SandboxProvider): ISandboxedExecutor {
  switch (provider) {
    case 'gvisor':
      return new GVisorExecutor();
    case 'seccomp':
      return new SeccompExecutor();
    case 'auto':
    default:
      // Return gVisor by default; availability checked at runtime
      return new GVisorExecutor();
  }
}

/**
 * Initializes the sandbox pool asynchronously
 */
async function initializeSandboxPool(): Promise<SandboxPool> {
  if (sandboxPoolInstance) {
    return sandboxPoolInstance;
  }

  const cfg = getConfig();
  const provider = (cfg.SANDBOX_PROVIDER as SandboxProvider) || 'auto';
  const minPoolSize = parseInt(String(cfg.SANDBOX_POOL_MIN || '2'), 10);
  const maxPoolSize = parseInt(String(cfg.SANDBOX_POOL_MAX || '10'), 10);

  // Check provider availability and create appropriate executor
  let executor: ISandboxedExecutor;
  
  if (provider === 'auto' || provider === 'gvisor') {
    const gvisor = new GVisorExecutor();
    if (await gvisor.isAvailable()) {
      executor = gvisor;
      log.info('Using gVisor executor');
    } else if (provider === 'gvisor') {
      throw new Error('gVisor (runsc) is not available on this system');
    } else {
      // Fallback to seccomp
      const seccomp = new SeccompExecutor();
      if (await seccomp.isAvailable()) {
        executor = seccomp;
        log.info('Using seccomp executor because gVisor is unavailable');
      } else {
        throw new Error('No sandbox provider available');
      }
    }
  } else {
    executor = new SeccompExecutor();
    const available = await executor.isAvailable();
    if (!available) {
      throw new Error('Seccomp is not available on this system');
    }
    log.info('Using seccomp executor');
  }

  sandboxPoolInstance = new SandboxPool(
    () => executor,
    {
      minPoolSize,
      maxPoolSize,
      maxConcurrentExecutions: maxPoolSize,
    },
  );

  await sandboxPoolInstance.initialize();
  return sandboxPoolInstance;
}

/**
 * Registers sandbox services with the DI container
 */
export function registerSandboxServices(): void {
  try {
    const cfg = getConfig();
    const provider = (cfg.SANDBOX_PROVIDER as SandboxProvider) || 'auto';
    const defaultTimeout = parseInt(String(cfg.SANDBOX_DEFAULT_TIMEOUT_MS || '60000'), 10);
    const defaultMemory = parseInt(String(cfg.SANDBOX_DEFAULT_MEMORY_MB || '512'), 10);

    log.info('Registering sandbox services', { provider });

    // Register the executor (synchronous - availability checked at runtime)
    container.register<ISandboxedExecutor>(
      DI_TOKENS.ISandboxExecutor,
      () => createExecutorSync(provider),
      {
        lifecycle: 'singleton',
        tags: ['sandbox', 'executor', 'security'],
        description: 'Sandboxed code execution service (gVisor/seccomp)',
      },
    );

    // Register the pool factory
    container.register<SandboxPool>(
      DI_TOKENS.ISandboxPool,
      () => {
        if (!sandboxPoolInstance) {
          throw new Error('Sandbox pool not initialized. Call initializeSandboxServices() first.');
        }
        return sandboxPoolInstance;
      },
      {
        lifecycle: 'singleton',
        tags: ['sandbox', 'pool', 'security'],
        description: 'Sandbox pool manager for efficient execution',
      },
    );

    // Register configuration
    container.register<SandboxModuleConfig>(
      'SandboxModuleConfig',
      () => ({
        provider,
        poolSize: { 
          min: parseInt(String(cfg.SANDBOX_POOL_MIN || '2'), 10), 
          max: parseInt(String(cfg.SANDBOX_POOL_MAX || '10'), 10),
        },
        defaultLimits: {
          timeoutMs: defaultTimeout,
          memoryLimitMb: defaultMemory,
        },
      }),
      {
        lifecycle: 'singleton',
        tags: ['sandbox', 'config'],
        description: 'Sandbox module configuration',
      },
    );

    container.register(
      DI_TOKENS.IProcessContainer,
      () => new MxcProcessContainer(container.resolve<IPlatformAdapter>(DI_TOKENS.IPlatformAdapter)),
      {
        lifecycle: 'singleton',
        tags: ['sandbox', 'process-container'],
        description: 'MXC process container for agent shell commands',
      },
    );

    log.info('Sandbox services registered', { provider });
  } catch (error) {
    log.error('Failed to register sandbox services', {
      error: error instanceof Error ? error.message : String(error),
    });
    log.warn('Sandbox services unavailable. Code execution will not be sandboxed.');
  }
}

/**
 * Initializes sandbox services asynchronously (must be called after registration)
 */
export async function initializeSandboxServices(): Promise<void> {
  const available = await isSandboxingAvailable();
  if (!available) {
    if (getConfig().NODE_ENV !== 'test') {
      log.warn('Sandbox providers unavailable on this system; continuing without sandbox pool.');
    }
    return;
  }

  try {
    await initializeSandboxPool();
    log.info('Sandbox pool initialized');
  } catch (error) {
    log.error('Failed to initialize sandbox pool', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Shuts down sandbox services gracefully
 */
export async function shutdownSandboxServices(): Promise<void> {
  if (sandboxPoolInstance) {
    await sandboxPoolInstance.shutdown();
    sandboxPoolInstance = null;
    log.info('Sandbox pool shut down');
  }
}

/**
 * Gets the configured sandbox provider type
 */
export function getSandboxProviderType(): SandboxProvider {
  const cfg = getConfig();
  return (cfg.SANDBOX_PROVIDER as SandboxProvider) || 'auto';
}

/**
 * Checks if sandboxing is available on this system
 */
export async function isSandboxingAvailable(): Promise<boolean> {
  try {
    const gvisor = new GVisorExecutor();
    if (await gvisor.isAvailable()) return true;
    
    const seccomp = new SeccompExecutor();
    if (await seccomp.isAvailable()) return true;
    
    return false;
  } catch {
    return false;
  }
}
