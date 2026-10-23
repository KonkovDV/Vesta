/**
 * Platform DI Module — registers IPlatformAdapter.
 *
 * Phase 4 bootstrap (earliest — platform info needed by all other modules).
 *
 * @layer Infrastructure (DI)
 * @phase Cross-Platform Compatibility V1
 */
import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import { NodeHttpJsonClient } from '../../http/HttpClient';
import { ContainerRegistryAdapter } from '../../platform/ContainerRegistryAdapter';
import { DockerGpuHealthAdapter } from '../../platform/DockerGpuHealthAdapter';
import { NodePlatformAdapter } from '../../platform/NodePlatformAdapter';

const NOOP_LOGGER: Pick<IStructuredLogger, 'warn' | 'error' | 'debug'> = {
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export function registerPlatformModule(): void {
  if (!container.isRegistered(DI_TOKENS.HttpClient)) {
    container.register(DI_TOKENS.HttpClient, () => new NodeHttpJsonClient(), {
      lifecycle: 'singleton',
      tags: ['platform', 'http'],
      description: 'Platform-level HTTP client for registry integrations',
    });
  }

  if (!container.isRegistered(DI_TOKENS.IPlatformAdapter)) {
    container.register(DI_TOKENS.IPlatformAdapter, () => new NodePlatformAdapter(), {
      lifecycle: 'singleton',
      tags: ['platform', 'core'],
      description: 'Cross-platform abstraction (process.platform, os.EOL, path.sep)',
    });
  }

  if (!container.isRegistered(DI_TOKENS.IContainerRegistryClient)) {
    container.register(
      DI_TOKENS.IContainerRegistryClient,
      (c) => new ContainerRegistryAdapter({
        httpClient: c.resolve(DI_TOKENS.HttpClient),
        ssrfGuard: c.resolve(DI_TOKENS.ISsrfDnsGuard),
        logger: resolveLogger(),
      }),
      {
        lifecycle: 'singleton',
        tags: ['platform', 'registry'],
        description: 'Container registry adapter for tags, manifests, and release metadata',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IGpuHealthMonitor)) {
    container.register(
      DI_TOKENS.IGpuHealthMonitor,
      () => new DockerGpuHealthAdapter({
        logger: resolveLogger(),
      }),
      {
        lifecycle: 'singleton',
        tags: ['platform', 'gpu'],
        description: 'Docker-based GPU health monitor via nvidia-smi probe',
      },
    );
  }
}

function resolveLogger(): Pick<IStructuredLogger, 'warn' | 'error' | 'debug'> {
  if (!container.isRegistered(DI_TOKENS.IStructuredLogger)) {
    return NOOP_LOGGER;
  }

  return container.resolve<Pick<IStructuredLogger, 'warn' | 'error' | 'debug'>>(DI_TOKENS.IStructuredLogger);
}
