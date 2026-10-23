/**
 * Centralized configuration for infrastructure components.
 * Layer: Infrastructure
 * 
 * @deprecated This file is a facade for backward compatibility.
 * Prefer injecting ConfigLoader from DI container instead.
 * 
 * Migration guide:
 * - Old: import { getRedisConfig } from './config';
 * - New: const cfg = container.resolve<ConfigLoader>('ConfigLoader').get();
 */

import { container } from '../../core/di/container';
import { ConfigLoader } from '../../config/ConfigLoader';
import type { InfraConfig } from '../../config/schema/definitions/infra.schema';

// Re-export type definitions for compatibility
export type RedisEventBusConfigLite = InfraConfig['redis'];
export type DatabaseConfig = InfraConfig['database'];
export type OutboxConfigLite = InfraConfig['outbox'];
export type SingularityConfig = {
  context: {
    hardCutoffPercent: number;
    maxContextTokens: number;
    minMessagesAfterPrune: number;
  };
  browser: {
    wsEndpoint: string | undefined;
    headless: boolean;
    navigationTimeoutMs: number;
  };
  namespace: string;
};

export type RedisConnectionConfig = InfraConfig['redis']['connection'];

export const DEFAULT_OUTBOX_CB_TIMEOUT_MS = 10000;
export const DEFAULT_OUTBOX_CB_SUCCESS_THRESHOLD = 5;
export const DEFAULT_OUTBOX_CB_FAILURE_THRESHOLD = 3;

/**
 * Helper to get ConfigLoader from DI container or create new instance.
 * Prefers DI-managed singleton when available.
 */
function getConfigLoader(): ConfigLoader {
  if (container.isRegistered('ConfigLoader')) {
    return container.resolve<ConfigLoader>('ConfigLoader');
  }
  // Fallback for legacy usage before bootstrap
  return new ConfigLoader();
}

/**
 * @deprecated Use container.resolve<ConfigLoader>('ConfigLoader').get().infra.redis instead
 */
export function getRedisEventBusConfig(): RedisEventBusConfigLite {
  return getConfigLoader().get().infra.redis;
}

/**
 * @deprecated Use container.resolve<ConfigLoader>('ConfigLoader').get().infra.database instead
 */
export function getDatabaseConfig(): DatabaseConfig {
  return getConfigLoader().get().infra.database;
}

/**
 * @deprecated Use container.resolve<ConfigLoader>('ConfigLoader').get().infra.outbox instead
 */
export function getOutboxConfig(): OutboxConfigLite {
   return getConfigLoader().get().infra.outbox;
}

/**
 * @deprecated Use container.resolve<ConfigLoader>('ConfigLoader').get() instead
 */
export function getSingularityConfig(): SingularityConfig {
  const cfg = getConfigLoader().get();
  return {
    context: {
        hardCutoffPercent: 95,
        maxContextTokens: cfg.physics?.memory?.maxContextTokens ?? 128000,
        minMessagesAfterPrune: 3,
    },
    browser: {
        wsEndpoint: cfg.SINGULARITY_BROWSER_WS_ENDPOINT as string | undefined,
        headless: (cfg.SINGULARITY_BROWSER_HEADLESS ?? true) as boolean,
        navigationTimeoutMs: (cfg.SINGULARITY_BROWSER_TIMEOUT_MS ?? 30000) as number,
    },
    namespace: (cfg.SINGULARITY_NAMESPACE || 'singularity') as string,
  };
}