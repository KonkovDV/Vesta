/**
 * Core infrastructure DI module.
 * Responsible for database, cache, logging/AOP, metrics, Slack integrations,
 * storage, feature flags, policy engine and plugin manifest services.
 * Layer: Infrastructure/DI.
 */
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { getConfig } from '../../../config';
import { createPostgresAdapterFromEnv } from '../../database/PostgresAdapter';
import { safeParseInt } from '../../../core/config/safe-parse';
import { createRedisAdapterFromEnv } from '../../cache/RedisAdapter';
import { createS3AdapterFromEnv } from '../../storage/S3Adapter';
import { StructuredLogger } from '../../logging/StructuredLogger';
import { PinoLoggerAdapter } from '../../logging/PinoLoggerAdapter';
import type { ILogger } from '../../../core/decorators/ILogger';
import { LoggingAspect } from '../../../core/aop/LoggingAspect';
import { MetricsAspect } from '../../../core/aop/MetricsAspect';
import { RetryAspect } from '../../../core/aop/RetryAspect';
import { CachingAspect } from '../../../core/aop/CachingAspect';
import { PrometheusMetricsAdapter } from '../../metrics/PrometheusMetricsAdapter';
import { InMemoryCircuitBreakerRegistry } from '../../resilience/InMemoryCircuitBreakerRegistry';
import { InMemoryCircuitBreakerFactory } from '../../resilience/InMemoryCircuitBreaker';
import { CircuitBreakerAspect } from '../../aop/CircuitBreakerAspect';
import type { ICircuitBreakerPolicyProvider } from '../../../core/resilience/ICircuitBreakerPolicyProvider';
import { NoopCircuitBreakerPolicyProvider } from '../../../core/resilience/ICircuitBreakerPolicyProvider';
import { PolicyBasedCircuitBreakerPolicyProvider } from '../../resilience/PolicyBasedCircuitBreakerPolicyProvider';
import { NoopCircuitBreakerEventObserver } from '../../../core/resilience/ICircuitBreakerEventObserver';
import type { ICircuitBreakerFactory } from '../../../core/resilience/ICircuitBreakerFactory';
import type { ICircuitBreakerRegistry } from '../../../core/resilience/ICircuitBreakerRegistry';
import type { ICircuitBreakerStateStore } from '../../../core/resilience/ICircuitBreakerStateStore';
import { PostgresCircuitBreakerStateStore } from '../../resilience/PostgresCircuitBreakerStateStore';
import { PostgresCircuitBreakerRegistry } from '../../resilience/PostgresCircuitBreakerRegistry';
import {
  createDisabledSlackIntegrationPort,
  createSlackHttpAdapterFromEnv,
} from '../../integrations/slack/slack-http-adapter';
import { SlackHttpClient } from '../../integrations/slack/slack-http-client';
import { IntegrationHub, type IIntegrationAdapter } from '../../../integration/integration-hub';
import { SlackIntegrationAdapter } from '../../../integration/slack/slack-adapter';
import { PostgresFeatureFlagsStore } from '../../feature-flags/PostgresFeatureFlagsStore';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { ConnectionState } from '../../../domain/persistence/IDatabaseConnection';
import { pgClientContext } from '../../database/PgClientContext';
import type { IManifestSchemaValidator } from '../../../domain/plugins/manifest/manifest-schema-validator.interface';
import type { IPluginManifestStore } from '../../../domain/plugins/manifest/plugin-manifest-store.interface';
import { AjvManifestSchemaValidator } from '../../plugins/manifest/AjvManifestSchemaValidator';
import { FileSystemPluginManifestStore } from '../../plugins/manifest/FileSystemPluginManifestStore';
import { PolicyEngineRuntime } from '../../policy/policy-engine.runtime';
import { RequestContext, AsyncLocalRequestContext } from '../../../core/context/request-context';
import path from 'path';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getCircuitBreakerPolicyProviderMode(config: Record<string, unknown>): string | undefined {
  const mode = config.CB_POLICY_PROVIDER;
  return typeof mode === 'string' ? mode : undefined;
}

function createInMemoryDatabaseConnection(): IDatabaseConnection {
  return {
    async query<T = unknown>(_sql: string, _params?: unknown[]) {
      return { rows: [] as T[], rowCount: 0 };
    },
    async queryOne<T = unknown>(_sql: string, _params?: unknown[]) {
      return null;
    },
    async queryScalar<T = unknown>(_sql: string, _params?: unknown[]) {
      return null;
    },
    async execute(_sql: string, _params?: unknown[]) {
      return 0;
    },
    async transaction<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
    async tableExists(_tableName: string): Promise<boolean> {
      return false;
    },
    async getTableSchema(_tableName: string) {
      return null;
    },
    async getConnectionInfo() {
      return {
        state: ConnectionState.CONNECTED,
        activeTransactions: 0,
      };
    },
    async isConnected(): Promise<boolean> {
      return true;
    },
    async close(): Promise<void> {
      // no-op for in-memory stub
    },
  };
}

function registerInMemoryCacheFallback(): void {
  type CacheSetOptions = import('../../../domain/cache/ICache').CacheSetOptions;

  class InMemoryCache {
    private store = new Map<string, { value: unknown; setAt: number; ttlSeconds?: number }>();
    private hits = 0;
    private misses = 0;

    private isExpired(key: string): boolean {
      const entry = this.store.get(key);
      if (!entry) return false;
      if (entry.ttlSeconds == null) return false;
      const age = (Date.now() - entry.setAt) / 1000;
      return age > entry.ttlSeconds;
    }

    private isExpiredAndCleanup(key: string): boolean {
      const entry = this.store.get(key);
      if (!entry) return false;
      if (entry.ttlSeconds == null) return false;
      const age = (Date.now() - entry.setAt) / 1000;
      const expired = age > entry.ttlSeconds;
      if (expired) {
        this.store.delete(key);
      }
      return expired;
    }

    private touchTTL(key: string, ttl?: number) {
      const entry = this.store.get(key);
      if (!entry) return;
      if (ttl && ttl > 0) {
        entry.ttlSeconds = ttl;
        entry.setAt = Date.now();
        this.store.set(key, entry);
      }
    }

    async get<T>(key: string): Promise<T | null> {
      if (this.isExpiredAndCleanup(key)) {
        return null;
      }
      const entry = this.store.get(key);
      if (entry) {
        this.hits++;
        return entry.value as T;
      }
      this.misses++;
      return null;
    }

    async getWithInfo<T>(key: string): Promise<{ value: T; cachedAt: number; ttlRemainingSeconds?: number } | null> {
      if (this.isExpiredAndCleanup(key)) {
        return null;
      }
      const entry = this.store.get(key);
      if (!entry) return null;
      const ttlRemainingSeconds =
        entry.ttlSeconds != null
          ? Math.max(0, entry.ttlSeconds - (Date.now() - entry.setAt) / 1000)
          : undefined;
      return {
        value: entry.value as T,
        cachedAt: entry.setAt,
        ttlRemainingSeconds,
      };
    }

    async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
      if (options?.onlyIfNotExists && this.store.has(key)) return;
      if (options?.onlyIfExists && !this.store.has(key)) return;
      this.store.set(key, { value, setAt: Date.now(), ttlSeconds: options?.ttlSeconds });
    }

    async setMany<T>(entries: Array<[string, T]>, options?: CacheSetOptions): Promise<void> {
      for (const [entryKey, value] of entries) {
        await this.set(entryKey, value, { ttlSeconds: options?.ttlSeconds });
      }
    }

    async delete(key: string): Promise<boolean> {
      return this.store.delete(key);
    }

    async deleteMany(keys: string[]): Promise<number> {
      let count = 0;
      for (const k of keys) {
        if (this.store.delete(k)) count++;
      }
      return count;
    }

    async exists(key: string): Promise<boolean> {
      if (this.isExpired(key)) {
        this.store.delete(key);
        return false;
      }
      return this.store.has(key);
    }

    async existsMany(keys: string[]): Promise<boolean[]> {
      const results: boolean[] = [];
      for (const k of keys) {
        results.push(await this.exists(k));
      }
      return results;
    }

    async increment(key: string, increment = 1): Promise<number> {
      if (this.isExpired(key)) {
        this.store.delete(key);
      }
      const current = await this.get<string>(key);
      const next = (current ? parseInt(current) : 0) + increment;
      const existing = this.store.get(key);
      this.store.set(key, { value: String(next), setAt: existing?.setAt ?? Date.now(), ttlSeconds: existing?.ttlSeconds });
      return next;
    }

    async getKeyInfo(key: string): Promise<{ key: string; setAt: number; ttlSeconds?: number; sizeBytes?: number; valueType?: string } | null> {
      if (this.isExpired(key)) {
        this.store.delete(key);
        return null;
      }
      const entry = this.store.get(key);
      if (!entry) return null;
      const sizeBytes = typeof entry.value === 'string' ? Buffer.byteLength(entry.value, 'utf8') : undefined;
      return {
        key,
        setAt: entry.setAt,
        ttlSeconds: entry.ttlSeconds,
        sizeBytes,
        valueType: typeof entry.value,
      };
    }

    async scanKeys(options?: { pattern?: string; limit?: number; offset?: number }): Promise<{ keys: string[]; cursor?: string; totalCount: number }> {
      const pattern = options?.pattern ?? '*';
      const globToRegex = (pat: string) => new RegExp('^' + pat.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      const regex = globToRegex(pattern);
      const allKeys = Array.from(this.store.keys()).filter(k => !this.isExpired(k) && regex.test(k));
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? allKeys.length;
      const keys = allKeys.slice(offset, offset + limit);
      return { keys, totalCount: allKeys.length };
    }

    async clear(): Promise<void> {
      this.store.clear();
    }

    async getStats(): Promise<{ totalKeys: number; hits: number; misses: number; hitRate: number; totalSizeBytes: number; averageValueSizeBytes: number }> {
      const keys = Array.from(this.store.keys()).filter(k => !this.isExpired(k));
      const totalKeys = keys.length;
      let totalSizeBytes = 0;
      for (const k of keys) {
        const entry = this.store.get(k);
        if (entry && typeof entry.value === 'string') {
          totalSizeBytes += Buffer.byteLength(entry.value, 'utf8');
        }
      }
      const totalRequests = this.hits + this.misses;
      return {
        totalKeys,
        hits: this.hits,
        misses: this.misses,
        hitRate: totalRequests > 0 ? this.hits / totalRequests : 0,
        totalSizeBytes,
        averageValueSizeBytes: totalKeys > 0 ? totalSizeBytes / totalKeys : 0,
      };
    }

    async touch(key: string, ttlSeconds?: number): Promise<boolean> {
      if (!(await this.exists(key))) return false;
      this.touchTTL(key, ttlSeconds);
      return true;
    }

    async ttl(key: string): Promise<number | null> {
      const entry = this.store.get(key);
      if (!entry) return null;
      if (entry.ttlSeconds == null) return null;
      const remaining = entry.ttlSeconds - (Date.now() - entry.setAt) / 1000;
      return remaining > 0 ? remaining : 0;
    }
  }

  container.register('ICache', () => new InMemoryCache(), {
    lifecycle: 'singleton',
    tags: ['cache', 'fallback'],
    description: 'In-memory cache fallback',
  });
}

function registerLocalStorageFallback(): void {
  container.register('IFileStorage', () => ({
    upload: async () => ({ url: '', etag: '', uploadedAt: new Date() }),
    download: async () => ({ buffer: Buffer.alloc(0), filename: '', mimeType: '', size: 0 }),
    delete: async () => false,
    exists: async () => false,
    isAvailable: async () => true,
  }), {
    lifecycle: 'singleton',
    tags: ['storage', 'fallback'],
    description: 'Local storage fallback',
  });
}

export function registerDatabaseServices(): void {
  // Set RequestContext as the ambient scope provider for automatic 'scoped' resolution
  container.setAmbientScopeProvider(RequestContext);

  try {
    container.register('IDatabaseConnection', () => {
      const cfg = getConfig();
      if (cfg.NODE_ENV === 'test') {
        return createInMemoryDatabaseConnection();
      }

      try {
        return createPostgresAdapterFromEnv();
      } catch (error) {
        console.warn(
          '⚠ Using in-memory DB stub for tests/env-missing:',
          getErrorMessage(error)
        );
        return createInMemoryDatabaseConnection();
      }
    }, {
      lifecycle: 'singleton',
      tags: ['database', 'postgresql', 'external'],
      description: 'PostgreSQL database connection (with test fallback)',
    });

    // Infrastructure-level UnitOfWork registration (lazy require to avoid cycles)
    container.register('IUnitOfWork', () => {
       
      const { PostgresUnitOfWork } = require('../../database/PostgresUnitOfWork') as typeof import('../../database/PostgresUnitOfWork');
      const db = container.resolve<import('../../../domain/persistence/IDatabaseConnection').IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
      return new PostgresUnitOfWork(db);
    }, {
      lifecycle: 'scoped',
      tags: ['unit-of-work', 'database', 'transactional'],
      description: 'PostgreSQL-based UnitOfWork coordinating DB and Outbox/EventStore',
    });

    // AsyncLocalStorage контекст транзакционного клиента PostgreSQL:
    // единый источник правды для всех транзакционных путей (IDatabaseConnection.transaction,
    // PostgresUnitOfWork, PostgresConversationRepository, Outbox интеграции).
    container.register(
      'PgClientContext',
      () => pgClientContext,
      {
        lifecycle: 'singleton',
        tags: ['database', 'transaction', 'als'],
        description: 'AsyncLocalStorage context for PostgreSQL transaction client',
      },
    );

    console.log('✓ Database services registered');
  } catch (error) {
    console.error('✗ Failed to register database services:', error);
    throw error;
  }
}

export function registerLoggingAndAOPServices(): void {
  try {
    const isProduction = process.env['NODE_ENV'] === 'production';

    if (isProduction) {
      // Production: Pino — async worker-thread serialization, fast NDJSON
      container.register('ILogger', () => new PinoLoggerAdapter('app'), {
        lifecycle: 'singleton',
        tags: ['logging', 'structured', 'json', 'pino'],
        description: 'Pino-backed structured JSON logger for production',
      });
      PinoLoggerAdapter.setCorrelationIdAccessor(() => {
        try {
          const ctx = AsyncLocalRequestContext.getCurrent();
          return ctx?.correlationId;
        } catch {
          return undefined;
        }
      });
    } else {
      // Development/test: StructuredLogger — synchronous, simpler debugging
      container.register('ILogger', () => new StructuredLogger('app'), {
        lifecycle: 'singleton',
        tags: ['logging', 'structured', 'json'],
        description: 'Structured JSON logger implementing ILogger interface',
      });
      StructuredLogger.setCorrelationIdAccessor(() => {
        try {
          const ctx = AsyncLocalRequestContext.getCurrent();
          return ctx?.correlationId;
        } catch {
          return undefined;
        }
      });
    }

    // IStructuredLogger is a type alias of ILogger — bind the same singleton (SpireX/DI alias pattern).
    if (container.isRegistered(DI_TOKENS.ILogger) && !container.isRegistered(DI_TOKENS.IStructuredLogger)) {
      container.register(
        DI_TOKENS.IStructuredLogger,
        (c) => c.resolve<ILogger>(DI_TOKENS.ILogger),
        {
          lifecycle: 'singleton',
          tags: ['logging', 'structured', 'alias'],
          description: 'Alias of ILogger for modules that resolve DI_TOKENS.IStructuredLogger',
        },
      );
    }
  } catch (error) {
    console.warn('⚠ ILogger registration skipped/failed:', error);
  }

  // NOTE: AOP aspects use 'transient' lifecycle to survive container.clearInstances()
  // which removes only singleton registrations. Aspects are stateless or use resolved deps.
  container.register('LoggingAspect', (c) => new LoggingAspect(c.resolve(DI_TOKENS.ILogger)), {
    lifecycle: 'transient',
    tags: ['aop', 'logging'],
    description: 'Cross-cutting logging aspect',
  });

  container.register('MetricsAspect', () => new MetricsAspect(), {
    lifecycle: 'transient',
    tags: ['aop', 'metrics'],
    description: 'Cross-cutting metrics aspect (prom-client based)',
  });

  container.register(
    'ICircuitBreakerPolicyProvider',
    () => {
      const cfg = getConfig();
      const modeRaw = getCircuitBreakerPolicyProviderMode(cfg);
      const mode = modeRaw?.toLowerCase();

      if (mode === 'noop' || mode === 'disabled' || mode === 'off') {
        return new NoopCircuitBreakerPolicyProvider();
      }

      return new PolicyBasedCircuitBreakerPolicyProvider();
    },
    {
      lifecycle: 'singleton',
      tags: ['resilience', 'circuit-breaker', 'policy'],
      description:
        'Circuit breaker policy provider (static profiles with optional noop mode via CB_POLICY_PROVIDER)',
    },
  );

  container.register(
    'ICircuitBreakerEventObserver',
    () => new NoopCircuitBreakerEventObserver(),
    {
      lifecycle: 'singleton',
      tags: ['resilience', 'circuit-breaker', 'observer'],
      description:
        'Hook-точка для наблюдения за событиями Circuit Breaker (готово к будущему OTEL/логгер-адаптеру).',
    },
  );

  container.register(
    'ICircuitBreakerFactory',
    (c) => new InMemoryCircuitBreakerFactory(
      c.resolve(DI_TOKENS.ICircuitBreakerEventObserver),
    ),
    {
      lifecycle: 'singleton',
      tags: ['resilience', 'circuit-breaker'],
      description: 'Factory for in-memory circuit breakers (ICircuitBreakerFactory)',
    },
  );

  // Optional Postgres-backed circuit breaker state store used by MAS advisors
  // and PostgresCircuitBreakerRegistry when CB_BACKEND=postgres.
  (() => {
    const cfg = getConfig();
    const backend = cfg.CB_BACKEND === 'postgres' ? 'postgres' : 'memory';
    if (backend === 'postgres') {
      container.register(
        'ICircuitBreakerStateStore',
        (c) => {
          const db = c.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
          return new PostgresCircuitBreakerStateStore(db);
        },
        {
          lifecycle: 'singleton',
          tags: ['resilience', 'circuit-breaker', 'state-store', 'postgresql'],
          description:
            'PostgreSQL-backed circuit breaker state store (cb_state table)',
        },
      );
    }
  })();

  container.register(
    'ICircuitBreakerRegistry',
    (c) => {
      const factory = c.resolve<ICircuitBreakerFactory>(DI_TOKENS.ICircuitBreakerFactory);
      const policyProvider = c.resolve<ICircuitBreakerPolicyProvider>(DI_TOKENS.ICircuitBreakerPolicyProvider);

      const cfg = getConfig();
      const backend = cfg.CB_BACKEND === 'postgres' ? 'postgres' : 'memory';

      if (backend === 'postgres') {
        const db = c.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
        const stateStore: ICircuitBreakerStateStore = new PostgresCircuitBreakerStateStore(db);
        return new PostgresCircuitBreakerRegistry(
          factory,
          policyProvider,
          stateStore,
        );
      }

      return new InMemoryCircuitBreakerRegistry(factory, policyProvider);
    },
    {
      lifecycle: 'singleton',
      tags: ['resilience', 'circuit-breaker', 'registry'],
      description:
        'Circuit breaker registry (in-memory by default, Postgres when CB_BACKEND=postgres)',
    },
  );

  container.register('CircuitBreakerAspect', (c) => {
    const cfg = getConfig();
    const envRaw = (cfg.NODE_ENV as string | undefined) ?? 'development';
    const environment =
      envRaw === 'production' || envRaw === 'test' || envRaw === 'stage'
        ? envRaw
        : 'development';

    const registry = c.resolve<ICircuitBreakerRegistry>(DI_TOKENS.ICircuitBreakerRegistry);
    return new CircuitBreakerAspect(registry, {
      environment,
      defaultChannel: 'HTTP',
    });
  }, {
    lifecycle: 'transient',
    tags: ['aop', 'resilience', 'circuit-breaker'],
    description: 'Cross-cutting circuit breaker aspect for external LLM/HTTP integrations',
  });

  container.register('RetryAspect', () => {
    const cfg = getConfig();

    const attempts = safeParseInt(cfg.AOP_RETRY_ATTEMPTS, 3);
    const delayMs = safeParseInt(cfg.AOP_RETRY_DELAY_MS, 100);
    
    const multiplierRaw = cfg.AOP_RETRY_MULTIPLIER;
    const parsedMultiplier = multiplierRaw ? Number.parseFloat(multiplierRaw) : NaN;
    const multiplier = Number.isFinite(parsedMultiplier) ? parsedMultiplier : 2;

    const maxDelayMs = safeParseInt(cfg.AOP_RETRY_MAX_DELAY_MS, 30000);

    return new RetryAspect({
      attempts,
      delayMs,
      multiplier,
      maxDelayMs,
    });
  }, {
    lifecycle: 'transient',
    tags: ['aop', 'resilience'],
    description: 'Cross-cutting retry aspect',
  });

  container.register('CachingAspect', (c) => {
    const cfg = getConfig();
    const prefix = cfg.AOP_CACHE_PREFIX && cfg.AOP_CACHE_PREFIX.length > 0
      ? cfg.AOP_CACHE_PREFIX
      : 'aop:cache';

    return new CachingAspect(c.resolve(DI_TOKENS.ICache), {
      keyPrefix: prefix,
    });
  }, {
    lifecycle: 'transient',
    tags: ['aop', 'cache'],
    description: 'Cross-cutting caching aspect',
  });

  // SecurityAspect registration moved to application layer to satisfy Clean Architecture constraints
}

export function registerCacheServices(): void {
  const cfg = getConfig();
  if (cfg.NODE_ENV === 'test') {
    registerInMemoryCacheFallback();
    return;
  }

  try {
    container.register('ICache', () => createRedisAdapterFromEnv(), {
      lifecycle: 'singleton',
      tags: ['cache', 'redis', 'external'],
      description: 'Redis cache service'
    });
    console.log('✓ Cache services registered');
  } catch (error) {
    console.warn('⚠ Failed to register cache services, using in-memory fallback:', error);
    registerInMemoryCacheFallback();
  }
}

export function registerMetricsServices(): void {
  try {
    // Conditional metrics adapter: NoOp for tests, Prometheus for production
    const cfg = getConfig();
    const isTestEnv = cfg.NODE_ENV === 'test';

    if (isTestEnv) {
      // Use no-op adapter in test environment to prevent Prometheus crashes
      const { NoOpMetricsAdapter } = require('../../metrics/NoOpMetricsAdapter') as typeof import('../../metrics/NoOpMetricsAdapter');
      container.register('IMetricsPort', () => new NoOpMetricsAdapter(), {
        lifecycle: 'singleton',
        tags: ['metrics', 'test', 'no-op'],
        description: 'No-op metrics adapter for test environment',
      });
    } else {
      // Use Prometheus adapter in production
      container.register('IMetricsPort', () => {
        const cfgLocal = getConfig();
        const prefix = cfgLocal.METRICS_PREFIX && cfgLocal.METRICS_PREFIX.length > 0
          ? cfgLocal.METRICS_PREFIX
          : 'microphoenix_';

        const service =
          cfgLocal.SERVICE_NAME && cfgLocal.SERVICE_NAME.length > 0
            ? cfgLocal.SERVICE_NAME
            : 'microphoenix';

        const enableDebugLogging = cfgLocal.METRICS_DEBUG === 'true';

        return new PrometheusMetricsAdapter({
          prefix,
          defaultLabels: { service },
          enableDebugLogging,
        });
      }, {
        lifecycle: 'singleton',
        tags: ['metrics', 'prometheus'],
        description: 'Metrics port (Prometheus adapter)',
      });
    }

    // Alias registration for backward compatibility (infra consumers)
    container.register('IBusinessMetrics', () => container.resolve(DI_TOKENS.IMetricsPort), {
      lifecycle: 'singleton',
      tags: ['metrics', 'alias'],
      description: 'Alias to IMetricsPort implementation',
    });

    console.log('✓ Metrics services registered');
  } catch (error) {
    console.warn('⚠ Failed to register metrics services:', error);
  }
}

export function registerSlackIntegrationServices(): void {
  try {
    const cfg = getConfig();
    if (!cfg.SLACK_BOT_TOKEN || cfg.SLACK_BOT_TOKEN.length === 0) {
      if (cfg.NODE_ENV !== 'test') {
        console.warn(
          '⚠ Slack integration not configured (SLACK_BOT_TOKEN is missing); registering disabled SlackIntegrationPort',
        );
      }
      container.register('SlackIntegrationPort', () => createDisabledSlackIntegrationPort(), {
        lifecycle: 'singleton',
        tags: ['integration', 'slack', 'disabled'],
        description:
          'Disabled Slack integration adapter that throws on use when SLACK_BOT_TOKEN is not configured',
      });
      return;
    }

    container.register('SlackIntegrationPort', () => createSlackHttpAdapterFromEnv(), {
      lifecycle: 'singleton',
      tags: ['integration', 'slack', 'external'],
      description:
        'Slack Web API adapter implementing SlackIntegrationPort (chat.postMessage)',
    });

    console.log('✓ Slack integration services registered');
  } catch (error) {
    console.warn(
      '⚠ Failed to register Slack integration services; falling back to disabled adapter:',
      error,
    );
    if (!container.isRegistered(DI_TOKENS.SlackIntegrationPort)) {
      container.register('SlackIntegrationPort', () => createDisabledSlackIntegrationPort(), {
        lifecycle: 'singleton',
        tags: ['integration', 'slack', 'disabled', 'fallback'],
        description:
          'Disabled Slack integration adapter used as fallback when real Slack adapter fails to initialize',
      });
    }
  }
}

export function registerIntegrationHub(): void {
  try {
    container.register(
      'slackHttpClient',
      () => {
        const cfg = getConfig();
        const webhookUrl = cfg.SLACK_WEBHOOK_URL;
        if (!webhookUrl && cfg.NODE_ENV !== 'test') {
          console.warn(
            '[IntegrationHub][Slack] SLACK_WEBHOOK_URL is not set; Slack webhook notifications will be disabled',
          );
        }

        return new SlackHttpClient({
          webhookUrl,
        });
      },
      {
        lifecycle: 'singleton',
        tags: ['integration', 'slack', 'webhook', 'http-client'],
        description:
          'Slack incoming webhook HTTP client used by SlackIntegrationAdapter (ENT Integration Hub connector)',
        aspectOptions: {
          annotations: ['http'],
          metadata: {
            integrationName: 'slack_webhook',
          },
        },
      },
    );

    container.register(
      'slackIntegrationAdapter',
      (c) => {
        const httpClient = c.resolve<SlackHttpClient>(DI_TOKENS.slackHttpClient);
        return new SlackIntegrationAdapter(httpClient);
      },
      {
        lifecycle: 'singleton',
        tags: ['integration', 'slack', 'connector'],
        description:
          'Slack integration adapter for ENT Integration Hub (webhook-based, minimal connector)',
      },
    );

    container.register(
      'integrationHub',
      (c) => {
        const hub = new IntegrationHub();
        const slackAdapter = c.resolve<SlackIntegrationAdapter>(DI_TOKENS.slackIntegrationAdapter);
        hub.registerAdapter(slackAdapter as unknown as IIntegrationAdapter);
        return hub;
      },
      {
        lifecycle: 'singleton',
        tags: ['integration', 'hub'],
        description:
          'In-memory Integration Hub registry for enterprise integrations (ENT Integration Hub Step1)',
      },
    );

    // PascalCase aliases for test compatibility
    if (!container.isRegistered('SlackHttpClient')) {
      container.register('SlackHttpClient', (c) => c.resolve('slackHttpClient'), {
        lifecycle: 'singleton',
        tags: ['integration', 'slack', 'alias'],
        description: 'Alias for slackHttpClient (PascalCase)',
      });
    }
    if (!container.isRegistered('SlackIntegrationAdapter')) {
      container.register('SlackIntegrationAdapter', (c) => c.resolve('slackIntegrationAdapter'), {
        lifecycle: 'singleton',
        tags: ['integration', 'slack', 'alias'],
        description: 'Alias for slackIntegrationAdapter (PascalCase)',
      });
    }
    if (!container.isRegistered('IntegrationHub')) {
      container.register('IntegrationHub', (c) => c.resolve('integrationHub'), {
        lifecycle: 'singleton',
        tags: ['integration', 'hub', 'alias'],
        description: 'Alias for integrationHub (PascalCase)',
      });
    }

    console.log('✓ Integration Hub services registered');
  } catch (error) {
    console.error('✗ Failed to register Integration Hub services:', error);
  }
}

export function registerStorageServices(): void {
  const cfg = getConfig();
  if (cfg.NODE_ENV === 'test') {
    registerLocalStorageFallback();
    return;
  }

  try {
    // Proactively check for AWS credentials to avoid runtime crash during resolution
    if (!cfg.AWS_ACCESS_KEY_ID || !cfg.AWS_SECRET_ACCESS_KEY || !cfg.AWS_S3_BUCKET) {
      console.warn('⚠ AWS credentials missing; skipping S3 adapter registration and using local fallback.');
      throw new Error('AWS credentials missing'); // Throw to trigger catch block which registers fallback
    }

    container.register(
      'IFileStorage',
      () => createS3AdapterFromEnv(),
      {
        lifecycle: 'singleton',
        tags: ['storage', 's3', 'aws', 'external'],
        description: 'Amazon S3 file storage',
        aspectOptions: {
          annotations: ['http'],
          metadata: {
            integrationName: 'aws_s3',
          },
        },
      },
    );
    console.log('✓ Storage services registered');
  } catch (error) {
    console.warn('⚠ Failed to register storage services, using local fallback:', error);
    registerLocalStorageFallback();
  }
}

export function registerFeatureFlagsStore(): void {
  try {
    container.register(
      'IFeatureFlagsStore',
      () => {
        const db = container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
        return new PostgresFeatureFlagsStore(db);
      },
      {
        lifecycle: 'singleton',
        tags: ['feature-flags', 'store', 'postgresql'],
        description: 'PostgreSQL-backed feature flags store (JSON in app_feature_flags table)',
      }
    );
    console.log('✓ Feature flags store registered');
  } catch (error) {
    console.warn('⚠ Failed to register feature flags store:', error);
  }
}

export function registerPolicyEngineServices(): void {
  try {
    container.register(
      'policyEngine',
      (c) => {
        const logger: Console | ILogger | undefined = c.isRegistered(DI_TOKENS.ILogger)
          ? c.resolve<ILogger>(DI_TOKENS.ILogger)
          : console;
        const eventStoreService = c.isRegistered('eventStoreService')
          ? c.resolve<{ saveDomainEvents(events: readonly unknown[]): Promise<void> }>('eventStoreService')
          : undefined;
        return new PolicyEngineRuntime(logger, eventStoreService);
      },
      {
        lifecycle: 'singleton',
        tags: ['security', 'policy', 'runtime'],
        description:
          'In-memory PolicyEngine runtime (MVP implementation; replace with externalized policy store in future iterations)',
      },
    );
    // PascalCase alias for test compatibility
    if (!container.isRegistered(DI_TOKENS.PolicyEngine)) {
      container.register(DI_TOKENS.PolicyEngine, (c) => c.resolve('policyEngine'), {
        lifecycle: 'singleton',
        tags: ['security', 'policy', 'alias'],
        description: 'Alias for policyEngine (PascalCase)',
      });
    }
    if (!container.isRegistered(DI_TOKENS.IPolicyEngine)) {
      container.register(DI_TOKENS.IPolicyEngine, (c) => c.resolve(DI_TOKENS.PolicyEngine), {
        lifecycle: 'singleton',
        tags: ['security', 'policy', 'alias'],
        description: 'Port name for the policy engine runtime',
      });
    }

    console.log('✓ PolicyEngine services registered');
  } catch (error) {
    console.error('✗ Failed to register PolicyEngine services:', error);
    throw error;
  }
}

export function registerPluginManifestServices(): void {
  try {
    container.register<IManifestSchemaValidator>(
      DI_TOKENS.IPluginManifestValidator,
      () =>
        // Package root, not the working directory: a project that depends on the
        // kernel runs from its own folder. Same depth from src/ and from dist/.
        new AjvManifestSchemaValidator(
          path.resolve(__dirname, '../../../../05-PLUGIN_SYSTEM/manifest-v2.schema.json'),
        ),
      {
        lifecycle: 'singleton',
        tags: ['plugins', 'manifest', 'validation'],
        description:
          'Ajv-based manifest v2 schema validator (runtime enforcement layer)',
      },
    );

    container.register<IPluginManifestStore>(
      'IPluginManifestStore',
      (c) =>
        new FileSystemPluginManifestStore(
          c.resolve<IManifestSchemaValidator>(DI_TOKENS.IPluginManifestValidator),
          process.cwd(),
        ),
      {
        lifecycle: 'singleton',
        tags: ['plugins', 'manifest', 'store'],
        description:
          'File-system plugin manifest store (YAML/JSON loader with schema validation and caching)',
      },
    );

    console.log('✓ Plugin manifest services registered');
  } catch (error) {
    console.error('✗ Failed to register plugin manifest services:', error);
    throw error;
  }
}
