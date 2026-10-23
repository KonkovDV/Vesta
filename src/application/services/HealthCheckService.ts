/**
 * Health Check Service
 * Layer: Application
 *
 * Предоставляет health check endpoints для всех критичных сервисов
 * и статус миграции от stub к real сервисам.
 */

import { IEventStore } from '../../domain/events/event-store.interface';
import { IEventBus } from '../../domain/events/event-bus.interface';
import { IOutbox } from '../../domain/events/outbox.interface';
import { FeatureFlagsService } from './FeatureFlagsService';
import { getRegistry, getOrCreateGauge } from '../../monitoring';
import { readStr } from '../../core/config/app-config';
import type { FeatureFlags } from '../../core/config/feature-flags';
import type { RateLimitService } from './RateLimitService';
import type { FeatureContext } from '@domain/features/FeatureContext';
import { RequestContext } from '../context/request-context';
import type { IAIClient } from '../../domain/ai/IAIClient';

// Discriminated union types for health check results
export type ServiceHealth =
  | { status: 'healthy'; latency: number; details?: Record<string, unknown> }
  | { status: 'unhealthy'; latency: number; error: string; details?: Record<string, unknown> }
  | { status: 'unknown'; error?: string };

export type MigrationStatus =
  | { status: 'up_to_date' }
  | { status: 'pending'; pendingMigrations: number }
  | { status: 'failed'; error: string }
  | { status: 'unknown' };

export type HealthCheckResult =
  | {
      status: 'healthy';
      timestamp: string;
      services: Record<string, Extract<ServiceHealth, { status: 'healthy' }>>;
      migration: MigrationHealth;
      version: string;
    }
  | {
      status: 'unhealthy' | 'degraded';
      timestamp: string;
      services: Record<string, ServiceHealth>;
      migration: MigrationHealth;
      version: string;
      error?: string;
    };

export interface MigrationHealth {
  overallProgress: number; // 0-100%
  services: Record<string, MigrationServiceHealth>;
  featureFlags: Record<string, boolean>;
}

export interface MigrationServiceHealth {
  stub: ServiceHealth;
  real: ServiceHealth;
  migrated: boolean;
  recommendedAction?: 'migrate' | 'wait' | 'rollback';
}

export class HealthCheckService {
  private cache: Map<string, { result: ServiceHealth; timestamp: number }> = new Map();

  private readonly healthGauge = getOrCreateGauge(
    'service_health_status',
    'Health status of core infrastructure services (1=healthy,0=unhealthy)',
    ['service', 'type']
  );
  private cacheTtlMs = 5000; // 5 секунд кэша
  private rateLimitMap: Map<string, { count: number; timestamp: number }> = new Map();
  private rateLimitWindowMs = 60000; // 1 minute window
  private rateLimitMaxRequests = 100; // max 100 requests per minute
  private readonly healthCheckTimeoutMs: number;

  constructor(
    private eventStore: IEventStore,
    private eventBus: IEventBus,
    private outbox: IOutbox,
    private featureFlags: FeatureFlagsService,
    private rateLimitService: RateLimitService,
    private aiClient?: IAIClient,
    healthCheckTimeoutMs?: number,
  ) {
    this.healthCheckTimeoutMs = healthCheckTimeoutMs ?? 5000;
  }
 
  /**
   * Построить FeatureContext из RequestContext (если он инициализирован).
   * Используется для контекстной оценки фич-флагов через isEnabledAsync.
   */
  private buildFeatureContext(): FeatureContext | undefined {
    try {
      const ctx = RequestContext.getContext();
      const featureContext: FeatureContext = {};
 
      if (ctx.userId) {
        featureContext.userId = String(ctx.userId);
      }
      if (ctx.tenantId) {
        featureContext.tenantId = String(ctx.tenantId);
      }
      if (ctx.sessionId) {
        featureContext.sessionId = String(ctx.sessionId);
      }
 
      return Object.keys(featureContext).length > 0 ? featureContext : undefined;
    } catch {
      // RequestContext может быть неинициализирован в некоторых флоу (например, background jobs).
      return undefined;
    }
  }
 
  /**
   * Обёртка над FeatureFlagsService, которая предпочитает async-API с FeatureContext
   * и безопасно падает обратно на snapshot‑чтение для тестовых stub'ов.
   */
  private async isFeatureEnabled(flag: keyof FeatureFlags): Promise<boolean> {
    if (typeof this.featureFlags.isEnabledAsync === 'function') {
      const context = this.buildFeatureContext();
      return this.featureFlags.isEnabledAsync(flag, context);
    }

    const allFlags = await this.featureFlags.getAllFlagsAsync();
    return allFlags[flag];
  }
 
  /**
   * Полный health check всех сервисов (prod-safe).
   *
   * Гарантии:
   * - Использует только доменные контракты (IEventStore/IEventBus/IOutbox).
   * - Любая ошибка или таймаут в критичных сервисах понижает статус до 'unhealthy' или 'degraded'.
   * - Не делает "оптимистичных" OK при отсутствии реального probe.
   */
  async checkAll(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    // Параллельные проверки всех сервисов с устойчивой обработкой ошибок
    const [
      eventStoreResult,
      eventBusResult,
      outboxResult,
      migrationResult,
      rateLimitResult,
      aiResult,
    ] = await Promise.allSettled([
      this.checkEventStore(),
      this.checkEventBus(),
      this.checkOutbox(),
      this.checkMigrationStatus(),
      this.checkRateLimitService(),
      this.checkAIClient(),
    ]);

    const eventStoreHealth: ServiceHealth =
      eventStoreResult.status === 'fulfilled'
        ? eventStoreResult.value
        : {
            status: 'unhealthy',
            latency: 0,
            error: this.normalizeErrorReason(eventStoreResult.reason),
          };

    const eventBusHealth: ServiceHealth =
      eventBusResult.status === 'fulfilled'
        ? eventBusResult.value
        : {
            status: 'unhealthy',
            latency: 0,
            error: this.normalizeErrorReason(eventBusResult.reason),
          };

    const outboxHealth: ServiceHealth =
      outboxResult.status === 'fulfilled'
        ? outboxResult.value
        : {
            status: 'unhealthy',
            latency: 0,
            error: this.normalizeErrorReason(outboxResult.reason),
          };

    const rateLimitHealth: ServiceHealth =
      rateLimitResult.status === 'fulfilled'
        ? rateLimitResult.value
        : {
            status: 'unhealthy',
            latency: 0,
            error: this.normalizeErrorReason(rateLimitResult.reason),
          };

    const aiHealth: ServiceHealth | undefined =
      aiResult.status === 'fulfilled'
        ? aiResult.value
        : {
            status: 'unhealthy',
            latency: 0,
            error: this.normalizeErrorReason(aiResult.reason),
          };

    const migrationStatus: MigrationHealth =
      migrationResult.status === 'fulfilled'
        ? migrationResult.value
        : {
            overallProgress: 0,
            services: {},
            featureFlags: {},
          };

    const totalLatency = Date.now() - startTime;
    
    // Определяем общий статус
    const services = {
      eventStore: eventStoreHealth,
      eventBus: eventBusHealth,
      outbox: outboxHealth,
      rateLimit: rateLimitHealth,
      ...(aiHealth ? { ai: aiHealth } : {}),
    };

    const criticalStatus = this.determineOverallStatus({
      eventStore: eventStoreHealth,
      eventBus: eventBusHealth,
      outbox: outboxHealth,
      rateLimit: rateLimitHealth,
    });

    const status =
      criticalStatus === 'healthy' && aiHealth?.status === 'unhealthy'
        ? 'degraded'
        : criticalStatus;
    
    return {
      status,
      timestamp: new Date().toISOString(),
      services,
      migration: migrationStatus,
      version: readStr('APP_VERSION', 'unknown') ?? 'unknown',
    } as HealthCheckResult;
  }

  /**
   * Совместимый с HTTP‑слоем псевдоним checkAll().
   *
   * [/health/detailed] ожидает метод checkHealth(); в Application‑слое
   * не дублируем логику, а просто делегируем на полноценный checkAll().
   */
  async checkHealth(): Promise<HealthCheckResult> {
    return this.checkAll();
  }

  /**
   * Health check для Event Store с таймаутом и кэшированием
   */
  private async checkEventStore(): Promise<ServiceHealth> {
    const cacheKey = 'eventStore';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;
 
    // Реальный probe: простое чтение/health-метод у IEventStore
  
    const startTime = Date.now();
    const timeoutMs = this.healthCheckTimeoutMs;

    let timeoutHandle: NodeJS.Timeout | undefined;
     
    try {
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Health check timeout')),
          timeoutMs
        );
      });
       
      const isHealthy = await Promise.race<boolean>([
        this.eventStore.isHealthy(),
        timeoutPromise
      ]);
       
      const latency = Date.now() - startTime;
       
      let result: ServiceHealth;
      if (!isHealthy) {
        result = {
          status: 'unhealthy',
          latency,
          error: 'Event Store health check failed',
        };
      } else {
        result = {
          status: 'healthy',
          latency,
          details: {
            type: (await this.isFeatureEnabled('useRealEventStore')) ? 'postgresql' : 'in-memory',
          },
        };
      }
       
      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      const latency = Date.now() - startTime;
      const result: ServiceHealth = {
        status: 'unhealthy',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      this.setCache(cacheKey, result);
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Health check для Event Bus с таймаутом и кэшированием
   */
  private async checkEventBus(): Promise<ServiceHealth> {
    const cacheKey = 'eventBus';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;
 
    // Реальный probe: ping/isHealthy у IEventBus с таймаутом
  
    const startTime = Date.now();
    const timeoutMs = this.healthCheckTimeoutMs;

    let timeoutHandle: NodeJS.Timeout | undefined;
     
    try {
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Health check timeout')),
          timeoutMs
        );
      });
       
      const isHealthy = await Promise.race<boolean>([
        this.eventBus.isHealthy(),
        timeoutPromise
      ]);
       
      const latency = Date.now() - startTime;
       
      let result: ServiceHealth;
      if (!isHealthy) {
        result = {
          status: 'unhealthy',
          latency,
          error: 'Event Bus health check failed',
        };
      } else {
        let metricsTimeoutHandle: NodeJS.Timeout | undefined;

        try {
          const metricsTimeout = new Promise<null>((resolve) => {
            metricsTimeoutHandle = setTimeout(() => resolve(null), 1000);
          });

          const metrics = await Promise.race([
            this.eventBus.getMetrics().catch(() => null),
            metricsTimeout
          ]);
           
          result = {
            status: 'healthy',
            latency,
            details: {
              type: (await this.isFeatureEnabled('useRealEventBus')) ? 'redis' : 'in-memory',
              subscriberCount: metrics?.subscriberCount ?? 0,
              eventsPublished: metrics?.eventsPublished ?? 0,
            },
          };
        } finally {
          if (metricsTimeoutHandle) {
            clearTimeout(metricsTimeoutHandle);
          }
        }
      }
       
      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      const latency = Date.now() - startTime;
      const result: ServiceHealth = {
        status: 'unhealthy',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      this.setCache(cacheKey, result);
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Health check для Outbox с таймаутом и кэшированием
   */
  private async checkOutbox(): Promise<ServiceHealth> {
    const cacheKey = 'outbox';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;
 
    // Реальный probe для Outbox:
    // - быстрый isHealthy()
    // - (опционально) чтение статистики с таймаутом, без паники при недоступности
  
    const startTime = Date.now();
    const timeoutMs = this.healthCheckTimeoutMs;

    let timeoutHandle: NodeJS.Timeout | undefined;
     
    try {
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Health check timeout')),
          timeoutMs
        );
      });
       
      const isHealthy = await Promise.race<boolean>([
        this.outbox.isHealthy(),
        timeoutPromise
      ]);
       
      const latency = Date.now() - startTime;
       
      let result: ServiceHealth;
      if (!isHealthy) {
        result = {
          status: 'unhealthy',
          latency,
          error: 'Outbox health check failed',
        };
      } else {
        let statsTimeoutHandle: NodeJS.Timeout | undefined;

        try {
          const statsTimeout = new Promise<null>((resolve) => {
            statsTimeoutHandle = setTimeout(() => resolve(null), 1000);
          });

          const stats = await Promise.race([
            this.outbox.getStats().catch(() => null),
            statsTimeout
          ]);
           
          result = {
            status: 'healthy',
            latency,
            details: {
              type: (await this.isFeatureEnabled('useRealOutbox')) ? 'postgresql' : 'in-memory',
              pendingMessages: stats?.pendingMessages ?? 0,
              publishedMessages: stats?.publishedMessages ?? 0,
              deadLetterMessages: stats?.deadLetterMessages ?? 0,
            },
          };
        } finally {
          if (statsTimeoutHandle) {
            clearTimeout(statsTimeoutHandle);
          }
        }
      }
       
      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      const latency = Date.now() - startTime;
      const result: ServiceHealth = {
        status: 'unhealthy',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      this.setCache(cacheKey, result);
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Health check для Rate Limit Service (Immune System)
   */
  private async checkRateLimitService(): Promise<ServiceHealth> {
    const cacheKey = 'rateLimit';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const startTime = Date.now();
    try {
      // Проверяем доступность через явный probe
      const isHealthy = await this.rateLimitService.isHealthy();
      
      if (!isHealthy) {
        throw new Error('RateLimitService reported unhealthy (cache unreachable)');
      }
      
      const latency = Date.now() - startTime;
      
      const result: ServiceHealth = {
        status: 'healthy',
        latency,
        details: {
           type: 'redis-token-bucket',
           message: 'Rate Limiter is active'
        }
      };
      
      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
       const result: ServiceHealth = {
        status: 'unhealthy',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      this.setCache(cacheKey, result);
      return result;
    }
  }

  private async checkAIClient(): Promise<ServiceHealth | undefined> {
    if (!this.aiClient) {
      return undefined;
    }

    const cacheKey = 'ai';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const startTime = Date.now();
    try {
      const isAvailable = await this.aiClient.isAvailable();
      const latency = Date.now() - startTime;
      const useMockAi = (readStr('USE_MOCK_AI', '') ?? '').toLowerCase() === 'true';

      const result: ServiceHealth = isAvailable
        ? {
            status: 'healthy',
            latency,
            details: {
              mode: useMockAi ? 'mock' : 'real',
            },
          }
        : {
            status: 'unhealthy',
            latency,
            error: 'AI client reported unavailable',
            details: {
              mode: useMockAi ? 'mock' : 'real',
            },
          };

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      const result: ServiceHealth = {
        status: 'unhealthy',
        latency: Date.now() - startTime,
        error: this.normalizeErrorReason(error),
      };
      this.setCache(cacheKey, result);
      return result;
    }
  }

  /**
   * Получить результат из кэша
   */
  private getFromCache(key: string): ServiceHealth | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.result;
  }

  /**
   * Сохранить результат в кэш
   */
  private setCache(key: string, result: ServiceHealth): void {
    this.cache.set(key, {
      result,
      timestamp: Date.now()
    });
  }

  /**
   * Проверка статуса миграции
   */
  async checkMigrationStatus(): Promise<MigrationHealth> {
    const [migrationStatus, featureFlagsSnapshot] = await Promise.all([
      this.featureFlags.getMigrationStatusAsync(),
      this.featureFlags.getAllFlagsAsync(),
    ]);
    
    const featureFlagsRecord: Record<string, boolean> = { ...featureFlagsSnapshot };
    
    // Анализируем каждый сервис
    const services: Record<string, MigrationServiceHealth> = {};
    
    // Event Store
    services.eventStore = {
      stub: await this.checkStubEventStore(),
      real: await this.checkRealEventStore(),
      migrated: migrationStatus.infrastructure?.eventStore?.migrated === true,
      recommendedAction: this.getRecommendedAction('eventStore', migrationStatus),
    };
    
    // Event Bus
    services.eventBus = {
      stub: await this.checkStubEventBus(),
      real: await this.checkRealEventBus(),
      migrated: migrationStatus.infrastructure?.eventBus?.migrated === true,
      recommendedAction: this.getRecommendedAction('eventBus', migrationStatus),
    };
    
    // Outbox
    services.outbox = {
      stub: await this.checkStubOutbox(),
      real: await this.checkRealOutbox(),
      migrated: migrationStatus.infrastructure?.outbox?.migrated === true,
      recommendedAction: this.getRecommendedAction('outbox', migrationStatus),
    };
    
    // Рассчитываем общий прогресс
    const totalServices = Object.keys(services).length;
    const migratedServices = Object.values(services).filter(s => s.migrated).length;
    const overallProgress = Math.round((migratedServices / totalServices) * 100);
    
    return {
      overallProgress,
      services,
      featureFlags: featureFlagsRecord,
    };
  }

  /**
   * Проверка stub Event Store
   */
  private async checkStubEventStore(): Promise<ServiceHealth> {
    return {
      status: 'healthy',
      latency: 0,
      details: {
        type: 'in-memory',
        message: 'Stub Event Store is always healthy',
      },
    };
  }

  /**
   * Проверка real Event Store
   */
  private async checkRealEventStore(): Promise<ServiceHealth> {
    if (!(await this.isFeatureEnabled('useRealEventStore'))) {
      return {
        status: 'unknown',
        error: 'Real Event Store not enabled',
      };
    }
 
    const startTime = Date.now();
    const timeoutMs = this.healthCheckTimeoutMs;

    let timeoutHandle: NodeJS.Timeout | undefined;
 
    try {
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Real Event Store health check timeout')),
          timeoutMs
        );
      });
 
      // Используем доменный контракт isHealthy() как единый probe.
      const isHealthy = await Promise.race<boolean>([
        this.eventStore.isHealthy(),
        timeoutPromise
      ]);
 
      const latency = Date.now() - startTime;
 
      if (!isHealthy) {
        return {
          status: 'unhealthy',
          latency,
          error: 'Real Event Store reported unhealthy',
        };
      }
 
      return {
        status: 'healthy',
        latency,
        details: {
          type: 'postgresql',
          message: 'Real Event Store is healthy',
        },
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      return {
        status: 'unhealthy',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Аналогичные методы для других сервисов...
   */
  private async checkStubEventBus(): Promise<ServiceHealth> {
    return { status: 'healthy', latency: 0, details: { type: 'in-memory' } };
  }

  private async checkRealEventBus(): Promise<ServiceHealth> {
    if (!(await this.isFeatureEnabled('useRealEventBus'))) {
      return {
        status: 'unknown',
        error: 'Real Event Bus not enabled',
      };
    }

    const startTime = Date.now();
    const timeoutMs = this.healthCheckTimeoutMs;

    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Real Event Bus health check timeout')),
          timeoutMs
        );
      });

      const isHealthy = await Promise.race([
        this.eventBus.isHealthy(),
        timeoutPromise
      ]);

      const latency = Date.now() - startTime;

      if (!isHealthy) {
        return {
          status: 'unhealthy',
          latency,
          error: 'Real Event Bus reported unhealthy',
        };
      }

      // Метрики EventBus опциональны и не влияют на основной статус.
      let metricsTimer: ReturnType<typeof setTimeout>;
      const metrics = await Promise.race([
        this.eventBus.getMetrics().catch(() => null),
        new Promise<null>((resolve) => { metricsTimer = setTimeout(() => resolve(null), 500); })
      ]).finally(() => clearTimeout(metricsTimer!)); // KI-006: prevent timer leak

      return {
        status: 'healthy',
        latency,
        details: {
          type: 'redis',
          subscriberCount: metrics?.subscriberCount ?? 0,
          eventsPublished: metrics?.eventsPublished ?? 0,
        },
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      return {
        status: 'unhealthy',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async checkStubOutbox(): Promise<ServiceHealth> {
    return { status: 'healthy', latency: 0, details: { type: 'in-memory' } };
  }

  private async checkRealOutbox(): Promise<ServiceHealth> {
    if (!(await this.isFeatureEnabled('useRealOutbox'))) {
      return {
        status: 'unknown',
        error: 'Real Outbox not enabled',
      };
    }

    const startTime = Date.now();
    const timeoutMs = this.healthCheckTimeoutMs;

    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Real Outbox health check timeout')),
          timeoutMs
        );
      });

      const isHealthy = await Promise.race([
        this.outbox.isHealthy(),
        timeoutPromise
      ]);

      const latency = Date.now() - startTime;

      if (!isHealthy) {
        return {
          status: 'unhealthy',
          latency,
          error: 'Real Outbox reported unhealthy',
        };
      }

      let statsTimer: ReturnType<typeof setTimeout>;
      const stats = await Promise.race([
        this.outbox.getStats().catch(() => null),
        new Promise<null>((resolve) => { statsTimer = setTimeout(() => resolve(null), 500); })
      ]).finally(() => clearTimeout(statsTimer!)); // KI-006: prevent timer leak

      return {
        status: 'healthy',
        latency,
        details: {
          type: 'postgresql',
          pendingMessages: stats?.pendingMessages ?? 0,
          publishedMessages: stats?.publishedMessages ?? 0,
          deadLetterMessages: stats?.deadLetterMessages ?? 0,
        },
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      return {
        status: 'unhealthy',
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Определение рекомендуемого действия
   */
  private getRecommendedAction(
    serviceName: string,
    migrationStatus: Awaited<ReturnType<FeatureFlagsService['getMigrationStatusAsync']>>
  ): 'migrate' | 'wait' | 'rollback' {
    // Логика рекомендаций на основе статуса
    const infrastructure = migrationStatus.infrastructure;
    const service = infrastructure?.[serviceName as keyof typeof infrastructure];
    
    if (!service) return 'wait';
    
    if (service.migrated) {
      // Уже мигрировано - проверяем health
      return service.real.status === 'healthy' ? 'wait' : 'rollback';
    } else {
      // Не мигрировано - проверяем готовность
      return service.stub.status === 'healthy' ? 'migrate' : 'wait';
    }
  }

  /**
   * Определение общего статуса системы
   */
  private determineOverallStatus(services: Record<string, ServiceHealth>): 'healthy' | 'unhealthy' | 'degraded' {
    const statuses = Object
      .values(services)
      .filter((s): s is ServiceHealth => !!s && typeof s.status === 'string')
      .map(s => s.status);
 
    if (statuses.length === 0) {
      return 'degraded';
    }
 
    if (statuses.every(s => s === 'healthy')) {
      return 'healthy';
    }
 
    if (statuses.some(s => s === 'unhealthy')) {
      return 'unhealthy';
    }
 
    return 'degraded';
  }
 
  /**
   * Безопасное нормализованное сообщение об ошибке для health‑чеков.
   */
  private normalizeErrorReason(reason: unknown): string {
    if (reason instanceof Error) {
      return reason.message;
    }
    try {
      return typeof reason === 'string' ? reason : JSON.stringify(reason);
    } catch {
      return 'Unknown error';
    }
  }
 
  /**
   * Получить метрики Prometheus
   */
  async getMetrics(): Promise<string> {
    const registry = getRegistry();
    return registry.metrics();
  }
}

// Factory для создания сервиса
export function createHealthCheckService(
  eventStore: IEventStore,
  eventBus: IEventBus,
  outbox: IOutbox,
  featureFlags: FeatureFlagsService,
  rateLimitService: RateLimitService,
  aiClient?: IAIClient,
): HealthCheckService {
  return new HealthCheckService(eventStore, eventBus, outbox, featureFlags, rateLimitService, aiClient);
}
