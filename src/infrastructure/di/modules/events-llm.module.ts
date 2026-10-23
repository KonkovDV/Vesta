/**
 * Events & LLM DI module.
 * Registers Event Store / Event Bus / Outbox and LLMAdapterFactory.
 * Also wires MAS Durable Execution infrastructure (MasExecutionStore, services, worker).
 * Layer: Infrastructure/DI.
 */
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { getConfig } from '../../../config';
import { validateAllEventServices } from '../../../core/config/config-validator';
import { safeParseInt } from '../../../core/config/safe-parse';
import type { IEventBus } from '../../../domain/events/event-bus.interface';
import { startOutboxWhenBusReady } from '../../events/start-outbox-when-bus-ready';
import type { IOutbox } from '../../../domain/events/outbox.interface';
import type { IEventStore } from '../../../domain/events/event-store.interface';
import type { PostgreSQLOutboxConfig } from '../../events/postgres-outbox';
import { createLLMAdapterFactoryFromEnv } from '../../factories/LLMAdapterFactory';
import { MasEventsRedisStreamsProducer } from '../../mas/MasEventsRedisStreamsProducer';
import { createMasRedisStreamsClientFromEnv, MasRedisStreamsClient } from '../../mas/MasRedisStreamsClient';
import { MasEventsRedisStreamsProjector, MasReadModelsRepository } from '../../mas/MasEventsRedisStreamsProjector';
import { isMasRedisStreamsProducerEnabled, isMasRedisStreamsProjectorsEnabled } from '../../../core/config/app-config';
import type { MasExecutionStore } from '../../../domain/mas/MasExecutionStore';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { MasDurableExecutionService } from '../../../domain/mas/services/MasDurableExecutionService';
import {
  MasRecoveryService,
  type IMasDurableExecutionPolicyProvider,
} from '../../../domain/mas/services/MasRecoveryService';
import { MasRecoveryWorker } from '../../mas/MasRecoveryWorker';
import { InMemoryMasExecutionStore } from '../../mas/InMemoryMasExecutionStore';
import type { ILogger } from '../../../core/decorators/ILogger';
import { MasCircuitBreakerAdvisor } from '../../mas/MasCircuitBreakerAdvisor';
import type { IMasCircuitBreakerAdvisor } from '../../../domain/mas/services/IMasCircuitBreakerAdvisor';
import type { ICircuitBreakerRegistry } from '../../../core/resilience/ICircuitBreakerRegistry';
import type { ICircuitBreakerStateStore } from '../../../core/resilience/ICircuitBreakerStateStore';
import {
  masRuntimePolicyServiceToken,
  type IMasRuntimePolicyService,
} from '../../../application/agents/core/mas-runtime-policy.service';

class EventServicesRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventServicesRegistrationError';
  }
}

interface InitializableService {
  initialize(): Promise<void>;
}

/**
 * Register event-related services (Event Store, Event Bus, Outbox, MAS durable execution)
 * and LLMAdapterFactory. This is a direct extraction of the logic from infrastructure
 * bootstrap to a dedicated module.
 */
export async function registerEventServices(): Promise<void> {
  try {
    // Валидация конфигурации перед регистрацией
    const validation = validateAllEventServices();
    if (!validation.isValid) {
      throw new EventServicesRegistrationError(
        `Event services configuration invalid: ${validation.errors.join(', ')}`,
      );
    }
    if (validation.warnings.length > 0) {
       
      console.warn('Event services config warnings:', validation.warnings);
    }

    // Динамический импорт для устранения циклических зависимостей
    const serviceFactoryResults = await Promise.allSettled([
      import('../../events/postgres-event-store'),
      import('../../events/redis-event-bus'),
      import('../../events/postgres-outbox'),
      import('../../mas/PostgresMasExecutionStore'),
    ]);
    const [
      postgresEventStoreResult,
      redisEventBusResult,
      postgresOutboxResult,
      postgresMasExecutionStoreResult,
    ] = serviceFactoryResults;

    if (postgresEventStoreResult.status === 'rejected') {
      throw postgresEventStoreResult.reason;
    }
    if (redisEventBusResult.status === 'rejected') {
      throw redisEventBusResult.reason;
    }
    if (postgresOutboxResult.status === 'rejected') {
      throw postgresOutboxResult.reason;
    }
    if (postgresMasExecutionStoreResult.status === 'rejected') {
      throw postgresMasExecutionStoreResult.reason;
    }

    const [
      { createPostgreSQLEventStoreFromEnv },
      { createRedisEventBusFromEnv },
      { createPostgreSQLOutbox },
      { createPostgresMasExecutionStoreFromEnv },
    ] = [
      postgresEventStoreResult.value,
      redisEventBusResult.value,
      postgresOutboxResult.value,
      postgresMasExecutionStoreResult.value,
    ];

    const cfg = getConfig();
    const isTest = cfg.NODE_ENV === 'test';

    if (isTest) {
      const { InMemoryEventStore } = await import('../../events/InMemoryEventStore');
      const { InMemoryEventBus } = await import('../../events/InMemoryEventBus');
      const { InMemoryOutbox } = await import('../../events/InMemoryOutbox');

      container.register('IEventStore', () => new InMemoryEventStore(), {
        lifecycle: 'singleton',
        tags: ['event-sourcing', 'infrastructure', 'memory', 'test'],
        description: 'In-Memory Event Store for testing',
      });

      container.register('IEventBus', () => new InMemoryEventBus(), {
        lifecycle: 'singleton',
        tags: ['event-sourcing', 'infrastructure', 'memory', 'test'],
        description: 'In-Memory Event Bus for testing',
      });

      container.register('IOutbox', () => new InMemoryOutbox(), {
        lifecycle: 'singleton',
        tags: ['event-sourcing', 'infrastructure', 'memory', 'test'],
        description: 'In-Memory Outbox for testing',
      });

      // MAS Durable Execution: In-memory store + services for tests
      container.register<MasExecutionStore>(
        'masExecutionStore',
        () => new InMemoryMasExecutionStore(),
        {
          lifecycle: 'singleton',
          tags: ['mas', 'durable-execution', 'memory', 'test'],
          description:
            'In-memory MAS Durable Execution store (test-only, no external dependencies)',
        },
      );

      registerDurableExecutionServices();

       
      console.log('✓ Event services registered (In-Memory Mocks for Testing)');
    } else {
      // Регистрация IEventStore
      // Регистрация IEventStore
      if (!container.isRegistered(DI_TOKENS.IEventStore)) {
        container.register('IEventStore', () => {
          const store = createPostgreSQLEventStoreFromEnv();
          return store;
        }, {
          lifecycle: 'singleton',
          tags: ['event-sourcing', 'infrastructure', 'postgresql'],
          description: 'PostgreSQL Event Store implementation',
        });
      }

      // Регистрация IEventBus
      // Регистрация IEventBus
      if (!container.isRegistered(DI_TOKENS.IEventBus)) {
        container.register('IEventBus', () => {
          const bus = createRedisEventBusFromEnv();
          return bus;
        }, {
          lifecycle: 'singleton',
          tags: ['event-sourcing', 'infrastructure', 'redis'],
          description: 'Redis Event Bus implementation',
        });
      }

      const masStreamsProducerEnabled = isMasRedisStreamsProducerEnabled();
      const masStreamsProjectorsEnabled = isMasRedisStreamsProjectorsEnabled();
      const masStreamsAnyEnabled = masStreamsProducerEnabled || masStreamsProjectorsEnabled;

      if (masStreamsAnyEnabled) {
        if (!container.isRegistered(DI_TOKENS.MasRedisStreamsClient)) {
          container.register(
            'MasRedisStreamsClient',
            () => createMasRedisStreamsClientFromEnv(),
            {
              lifecycle: 'singleton',
              tags: ['mas', 'events', 'redis-streams'],
              description:
                'Redis Streams client for MAS events pilot (mas:events stream; R2.3 observability/CQRS pipeline)',
            },
          );
        }
      }

      if (masStreamsProducerEnabled) {
        container.register(
          'MasEventsRedisStreamsProducer',
          (c) => {
            const busInstance = c.resolve<IEventBus>(DI_TOKENS.IEventBus);
            const client = c.resolve<MasRedisStreamsClient>(DI_TOKENS.MasRedisStreamsClient);
            const producer = new MasEventsRedisStreamsProducer(busInstance, client);

            void producer.initialize().catch((error: unknown) => {
               
              console.error(
                '[MasEventsRedisStreamsProducer] Failed to initialize MAS Redis Streams producer',
                error,
              );
            });

            return producer;
          },
          {
            lifecycle: 'singleton',
            tags: ['mas', 'events', 'redis-streams', 'producer'],
            description:
              'MAS events → Redis Streams producer (EventBus tap for mas.session.* / mas.task.*; R2.3 pilot)',
          },
        );
      }

      if (masStreamsProjectorsEnabled) {
        container.register(
          'MasReadModelsRepository',
          (c) => {
            const db = c.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
            return new MasReadModelsRepository(db);
          },
          {
            lifecycle: 'singleton',
            tags: ['mas', 'events', 'read-model', 'postgresql'],
            description:
              'MAS sessions/tasks CQRS read models repository (mas_session_read_model, mas_task_stats_read_model; R2.3 pilot)',
          },
        );

        container.register(
          'MasEventsRedisStreamsProjector',
          (c) => {
            const client = c.resolve<MasRedisStreamsClient>(DI_TOKENS.MasRedisStreamsClient);
            const repo = c.resolve<MasReadModelsRepository>(DI_TOKENS.MasReadModelsRepository);
            const projector = new MasEventsRedisStreamsProjector(client, repo);

            void projector.start().catch((error: unknown) => {
               
              console.error(
                '[MasEventsRedisStreamsProjector] Failed to start MAS Redis Streams projector',
                error,
              );
            });

            return projector;
          },
          {
            lifecycle: 'singleton',
            tags: ['mas', 'events', 'redis-streams', 'projector'],
            description:
              'MAS Redis Streams → Postgres CQRS read models projector (mas:events → mas_session_read_model / mas_task_stats_read_model; R2.3 pilot)',
          },
        );
      }

      // Регистрация IOutbox (обязательный для production, Outbox-first паттерн)
      if (!container.isRegistered(DI_TOKENS.IOutbox)) {
        container.register('IOutbox', () => {
          try {
          const eventStore = container.resolve<IEventStore>(DI_TOKENS.IEventStore);
          const eventBus = container.resolve<IEventBus>(DI_TOKENS.IEventBus);

          const cfgLocal = getConfig();

          // Use the validated configuration from AppConfig.infra.outbox
          // This avoids issues with manual parsing and ensures fallbacks (to EVENT_STORE_*) are respected.
          const outboxConfig = cfgLocal.infra.outbox as unknown as PostgreSQLOutboxConfig;

          const outbox = createPostgreSQLOutbox(
            outboxConfig,
            eventStore,
            eventBus,
          );

          const env = (cfgLocal.NODE_ENV || 'development').toLowerCase();
          const isTest = env === 'test';
          // Auto-start default: true in dev/prod, false in test
          const defaultAutoStart = isTest ? 'false' : 'true';
          const shouldAutoStart =
            env === 'production' ||
            (cfgLocal.OUTBOX_AUTO_START ?? defaultAutoStart).toLowerCase() === 'true';

          if (shouldAutoStart && typeof outbox.startProcessing === 'function') {
            void startOutboxWhenBusReady(eventBus, outbox).catch((err: unknown) => {
               
              console.error('[IOutbox] Failed to start processing:', err);
              if (env === 'production') {
                throw err;
              }
            });
          } else if (!shouldAutoStart && env !== 'production') {
             
            console.log(
              `[IOutbox] Auto-start disabled (env=${env}, OUTBOX_AUTO_START=${String(
                cfgLocal.OUTBOX_AUTO_START ?? defaultAutoStart,
              )}). ` +
                'Outbox processing worker is NOT running in this environment.',
            );
          }

          return outbox;
        } catch (error) {
           
          console.error('[IOutbox] Creation failed:', error);
          throw error;
        }
      }, {
        lifecycle: 'singleton',
        tags: ['event-sourcing', 'infrastructure', 'outbox'],
        description:
          'PostgreSQL Outbox implementation (auto-processing when enabled)',
      });
      }

      // MAS Durable Execution: Postgres-backed store + services
      container.register<MasExecutionStore>(
        'masExecutionStore',
        () => {
          const eventStore = container.resolve<IEventStore>(DI_TOKENS.IEventStore);
          const outbox = container.isRegistered(DI_TOKENS.IOutbox)
            ? container.resolve<IOutbox>(DI_TOKENS.IOutbox)
            : undefined;
          return createPostgresMasExecutionStoreFromEnv(eventStore, outbox);
        },
        {
          lifecycle: 'singleton',
          tags: ['mas', 'durable-execution', 'postgresql', 'infrastructure'],
          description:
            'PostgreSQL-backed MAS Durable Execution store (task executions + steps)',
        },
      );
 
      registerDurableExecutionServices();

      // Optionally start MAS Durable Execution recovery worker (production/dev only).
      try {
        const env = (cfg.NODE_ENV || 'development').toLowerCase();
        const autoStartRecovery =
          String(cfg.MAS_RECOVERY_AUTO_START ?? 'true').toLowerCase() === 'true';

        if (
          autoStartRecovery &&
          container.isRegistered('MasRecoveryWorker') &&
          (env === 'production' || env === 'development')
        ) {
          const worker = container.resolve<MasRecoveryWorker>('MasRecoveryWorker');
          worker.start();
           
          console.log(
            '[MasRecoveryWorker] Auto-start enabled (env=%s)',
            env,
          );
        } else if (!autoStartRecovery && env !== 'production') {
           
          console.log(
            '[MasRecoveryWorker] Auto-start disabled (env=%s, MAS_RECOVERY_AUTO_START=%s)',
            env,
            String(cfg.MAS_RECOVERY_AUTO_START ?? 'false'),
          );
        }
      } catch (error) {
         
        console.error(
          '[MasRecoveryWorker] Failed to start recovery worker',
          error,
        );
      }
 
       
      console.log('✓ Event services registered (IEventStore, IEventBus, IOutbox)');
    }

    // Регистрация LLMAdapterFactory как инфраструктурного сервиса (каноничный путь)
    if (!container.isRegistered(DI_TOKENS.LLMAdapterFactory)) {
      container.register(
        DI_TOKENS.LLMAdapterFactory,
        () => {
          try {
            const factory = createLLMAdapterFactoryFromEnv();
            return factory;
          } catch (error) {
             
            console.error('[LLMAdapterFactory] Initialization failed:', error);
            throw error;
          }
        },
        {
          lifecycle: 'singleton',
          tags: ['llm', 'infrastructure'],
          description:
            'LLM Adapter Factory (DI-managed; do not use getInstance() in production code)',
        },
      );
    }
  } catch (error) {
     
    console.error('Check Failed to register event services:', error);
    throw error;
  }
}

/**
 * Инициализация схем баз данных для всех событийных сервисов.
 * Вызывается явно во время bootstrap инфраструктуры.
 */
export async function initializeEventServicesSchema(): Promise<void> {
  try {
     
    console.log('[EventsModule] Initializing database schemas for events infrastructure...');

    // 0. Шина должна принять publish до первого тика outbox.
    if (container.isRegistered(DI_TOKENS.IEventBus)) {
      const bus = container.resolve<IEventBus & Partial<InitializableService>>(DI_TOKENS.IEventBus);
      if (typeof bus.initialize === 'function') {
        await bus.initialize();
        console.log('✓ Event Bus initialized');
      }
    }

    // 1. Инициализация Event Store
    if (container.isRegistered(DI_TOKENS.IEventStore)) {
      const store = container.resolve<IEventStore & Partial<InitializableService>>(DI_TOKENS.IEventStore);
      if (typeof store.initialize === 'function') {
        await store.initialize();
         
        console.log('✓ PostgreSQL Event Store schema initialized');
      }
    }

    // 2. Инициализация Outbox
    if (container.isRegistered(DI_TOKENS.IOutbox)) {
      const outbox = container.resolve<IOutbox & Partial<InitializableService>>(DI_TOKENS.IOutbox);
      if (typeof outbox.initialize === 'function') {
        await outbox.initialize();
         
        console.log('✓ PostgreSQL Outbox schema initialized');
      }
    }

    // 3. Инициализация MAS Durable Execution Store
    if (container.isRegistered(DI_TOKENS.masExecutionStore)) {
      const masStore = container.resolve<MasExecutionStore & Partial<InitializableService>>(DI_TOKENS.masExecutionStore);
      if (typeof masStore.initialize === 'function') {
        await masStore.initialize();
         
        console.log('✓ PostgreSQL MAS Execution Store schema initialized');
      }
    }

     
    console.log('✅ Events infrastructure schemas initialized successfully');
  } catch (error) {
     
    console.error('💥 Failed to initialize event service schemas:', error);
    // Мы не прокидываем ошибку дальше, так как таблицы могли быть созданы частично
    // или это не-Postgres окружение (хотя в prod/dev это критично).
    // Однако для надежности bootstrap лучше выбросить ошибку если это критическая инф-ра.
    throw error;
  }
}

/**
 * Register MAS Durable Execution core services and worker once MasExecutionStore
 * is available in the DI container.
 */
function registerDurableExecutionServices(): void {
  if (!container.isRegistered(DI_TOKENS.masExecutionStore)) {
    return;
  }

  container.register(
    'IMasCircuitBreakerAdvisor',
    c => {
      const cfg = getConfig();
      const backend = cfg.CB_BACKEND === 'postgres' ? 'postgres' : 'memory';

      const registry = c.isRegistered(DI_TOKENS.ICircuitBreakerRegistry)
        ? c.resolve<ICircuitBreakerRegistry>(DI_TOKENS.ICircuitBreakerRegistry)
        : undefined;

      if (backend === 'postgres') {
        const stateStore = c.isRegistered(DI_TOKENS.ICircuitBreakerStateStore)
          ? c.resolve<ICircuitBreakerStateStore>(DI_TOKENS.ICircuitBreakerStateStore)
          : undefined;

        if (stateStore && registry) {
          return new MasCircuitBreakerAdvisor(stateStore, registry);
        }

        return new MasCircuitBreakerAdvisor(undefined, registry);
      }

      if (registry) {
        return new MasCircuitBreakerAdvisor(undefined, registry);
      }

      const noop: IMasCircuitBreakerAdvisor = {
        async getSnapshotForKey() {
          return null;
        },
      };
      return noop;
    },
    {
      lifecycle: 'singleton',
      tags: ['mas', 'durable-execution', 'recovery', 'circuit-breaker'],
      description:
        'MAS-aware circuit breaker advisor (Postgres + registry when available, otherwise best-effort/noop)',
    },
  );

  container.register(
    'masDurableExecutionService',
    c => {
      const store = c.resolve<MasExecutionStore>(DI_TOKENS.masExecutionStore);
      const logger: ILogger | undefined = c.isRegistered(DI_TOKENS.ILogger)
        ? (c.resolve(DI_TOKENS.ILogger))
        : undefined;
      return createMasDurableExecutionService(store, logger);
    },
    {
      lifecycle: 'singleton',
      tags: ['mas', 'durable-execution', 'core'],
      description:
        'MAS Durable Execution service facade over MasExecutionStore (start tasks/steps, complete/fail steps)',
    },
  );

  container.register(
    'masRecoveryService',
    c => {
      const store = c.resolve<MasExecutionStore>(DI_TOKENS.masExecutionStore);
      const advisor = c.isRegistered(DI_TOKENS.IMasCircuitBreakerAdvisor)
        ? (c.resolve<IMasCircuitBreakerAdvisor>(DI_TOKENS.IMasCircuitBreakerAdvisor))
        : undefined;

      const durablePolicyProvider:
        | IMasDurableExecutionPolicyProvider
        | undefined = container.isRegistered(
        masRuntimePolicyServiceToken,
      )
        ? c.resolve<IMasRuntimePolicyService>(
            masRuntimePolicyServiceToken,
          )
        : undefined;

      return createMasRecoveryService(store, advisor, durablePolicyProvider);
    },
    {
      lifecycle: 'singleton',
      tags: ['mas', 'durable-execution', 'recovery', 'core'],
      description:
        'MAS Durable Execution recovery analysis service (builds recovery plans for stuck tasks/steps)',
    },
  );

  container.register(
    'masRecoveryWorker',
    c => {
      const recoveryService = c.resolve<MasRecoveryService>(
        'masRecoveryService',
      );
      const store = c.resolve<MasExecutionStore>(DI_TOKENS.masExecutionStore);
      const logger: ILogger | undefined = c.isRegistered(DI_TOKENS.ILogger)
        ? (c.resolve(DI_TOKENS.ILogger))
        : undefined;
      return createMasRecoveryWorker(recoveryService, store, logger);
    },
    {
      lifecycle: 'singleton',
      tags: ['mas', 'durable-execution', 'recovery', 'worker'],
      description:
        'MAS Durable Execution recovery worker (periodic analysis and application of recovery plans)',
    },
  );
}

const createMasDurableExecutionService = (
  store: MasExecutionStore,
  logger?: ILogger,
): MasDurableExecutionService => new MasDurableExecutionService(store, logger);

const createMasRecoveryService = (
  store: MasExecutionStore,
  circuitBreakerAdvisor?: IMasCircuitBreakerAdvisor,
  durablePolicyProvider?: IMasDurableExecutionPolicyProvider,
): MasRecoveryService =>
  new MasRecoveryService(store, circuitBreakerAdvisor, durablePolicyProvider);

const createMasRecoveryWorker = (
  recoveryService: MasRecoveryService,
  store: MasExecutionStore,
  logger?: ILogger,
): MasRecoveryWorker =>
  // createMasRecoveryWorker factory helper (treated as factory by architecture tests)
  new MasRecoveryWorker(
    recoveryService,
    store,
    logger,
  );