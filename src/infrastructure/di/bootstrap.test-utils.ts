/**
 * Test/development helpers extracted from bootstrap.ts.
 */
import { container } from '../../core/di/container';
import { DI_TOKENS } from '../../core/di/DI_TOKENS';
import { DeterministicRng } from '../../core/utils/DeterministicRng';
import type { BootstrapConfig } from './bootstrap.types';
import {
  registerAIServices as registerModuleAIServices,
  registerResearchServices as registerModuleResearchServices,
  registerChatRuntime as registerModuleChatRuntime,
} from './modules/ai.module';
import {
  registerDatabaseServices as registerCoreInfraDatabaseServices,
  registerLoggingAndAOPServices as registerCoreInfraLoggingAndAOPServices,
  registerCacheServices as registerCoreInfraCacheServices,
  registerMetricsServices as registerCoreInfraMetricsServices,
  registerSlackIntegrationServices as registerCoreInfraSlackIntegrationServices,
  registerIntegrationHub as registerCoreInfraIntegrationHub,
  registerStorageServices as registerCoreInfraStorageServices,
  registerFeatureFlagsStore as registerCoreInfraFeatureFlagsStore,
  registerPolicyEngineServices as registerCoreInfraPolicyEngineServices,
  registerPluginManifestServices as registerCoreInfraPluginManifestServices,
} from './modules/core-infra.module';
import { registerMemoryModuleServices } from './modules/memory.module';
import { registerMasCoreServices as registerMasCoreModuleServices } from './modules/mas-core.module';
import { registerRepositoryServices } from './modules/repositories.module';
import { registerApplicationServices } from './modules/application.module';
import { registerHttpModule } from './modules/http.module';
import { registerPlatformModule } from './modules/platform.module';
import { registerSsrfDnsGuard, registerToolPolicyResolver } from './modules/security.module';
import { registerUserApprovalModule } from './modules/user-approval.module';
import { ToolRegistry } from '../../application/agents/services/ToolRegistry';
import { MarkovContextPredictor } from '../context/prediction/MarkovContextPredictor';
import { QueryExpansionServiceAdapter } from '../memory/query/QueryExpansionServiceAdapter';

export function setupContainer(config: BootstrapConfig): typeof container {
  container.clear();

  const shouldQuiet = (config?.quiet ?? (config?.environment === 'test')) === true;

  const originalConsole = { ...console };
  const silence = () => {
    console.log = () => undefined;
    console.info = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
  };
  const restore = () => {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  };

  if (shouldQuiet) {
    silence();
  }

  try {
    // Register IConfigLoader early — modules (memory, mas-core, hermes) depend on it
    if (!container.isRegistered('IConfigLoader')) {
      const { ConfigLoader } = require('../../config/ConfigLoader') as typeof import('../../config/ConfigLoader');
      const configLoader = new ConfigLoader();
      configLoader.load();
      container.register(DI_TOKENS.IConfigLoader, () => configLoader, { lifecycle: 'singleton' });
      container.register('ConfigLoader', () => configLoader, { lifecycle: 'singleton' });
    }

    registerModuleAIServices();
    registerModuleResearchServices();
    registerCoreInfraDatabaseServices();
    registerCoreInfraCacheServices();
    registerCoreInfraMetricsServices();
    registerCoreInfraSlackIntegrationServices();
    registerCoreInfraIntegrationHub();
    registerCoreInfraStorageServices();
    registerCoreInfraLoggingAndAOPServices();
    registerCoreInfraFeatureFlagsStore();
    registerCoreInfraPolicyEngineServices();
    registerCoreInfraPluginManifestServices();
    registerUserApprovalModule();
    registerSsrfDnsGuard();
    registerPlatformModule();
    registerMemoryModuleServices();
    registerMasCoreModuleServices();
    registerModuleChatRuntime();
    registerRepositoryServices(Boolean(config?.useInMemoryRepositories));
    registerApplicationServices();
    registerToolPolicyResolver();

    if (!container.isRegistered(DI_TOKENS.IToolRegistry)) {
      container.register(
        DI_TOKENS.IToolRegistry,
        (c) => new ToolRegistry(
          c.resolve(DI_TOKENS.ILogger),
          c.resolve(DI_TOKENS.IToolExecutionPolicy),
        ),
        {
          lifecycle: 'singleton',
          tags: ['interaction', 'tools', 'registry', 'test-helper'],
          description: 'Tool Registry registered directly in setupContainer() for test-safe DI smoke coverage',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.DeterministicRng)) {
      container.register(
        DI_TOKENS.DeterministicRng,
        () => new DeterministicRng(42),
        {
          lifecycle: 'singleton',
          tags: ['seed-injection', 'rng', 'test-helper'],
          description: 'Deterministic RNG registered directly in setupContainer() for test-safe DI smoke coverage',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IQueryPredictor)) {
      container.register(
        DI_TOKENS.IQueryPredictor,
        (c) => new MarkovContextPredictor(2, c.resolve(DI_TOKENS.DeterministicRng)),
        {
          lifecycle: 'singleton',
          tags: ['prediction', 'markov', 'test-helper'],
          description: 'Query predictor registered directly in setupContainer() for test-safe DI smoke coverage',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IQueryExpansionService)) {
      container.register(
        DI_TOKENS.IQueryExpansionService,
        () => new QueryExpansionServiceAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'query-expansion', 'test-helper'],
          description: 'Query expansion service registered directly in setupContainer() for test-safe DI smoke coverage',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IMcpExtractionServer)) {
      container.register<{ name: string; version: string }>(
        DI_TOKENS.IMcpExtractionServer,
        () => ({
          name: 'microphoenix-extraction',
          version: '1.2.0',
        }),
        {
          lifecycle: 'singleton',
          tags: ['mcp', 'extraction', 'dev-tool', 'test-helper'],
          description: 'MCP Extraction Server metadata registered directly in setupContainer() for test-safe DI smoke coverage',
        },
      );
    }

    registerHttpModule();

    if (!container.isRegistered('IEventBus')) {
      const eventBusStub = {
        publish: async () => undefined,
        publishBatch: async () => undefined,
        subscribe: async () => 'sub-1',
        unsubscribe: async () => undefined,
        unsubscribeAll: async () => undefined,
        isSubscribed: async () => true,
        getSubscriberCount: async () => 1,
        getSubscriberInfo: async () => null,
        getAllSubscriptions: async () => [],
        getMetrics: async () => ({
          eventsPublished: 0,
          eventsFailed: 0,
          averageProcessingTime: 0,
          subscriberCount: 0,
          channelCount: 0,
          uptime: 0,
        }),
        isHealthy: async () => true,
        getDeadLetterQueue: async () => [],
        replayDeadLetterEvent: async () => undefined,
        clearDeadLetterQueue: async () => undefined,
        initialize: async () => undefined,
        close: async () => undefined,
      };
      container.register('IEventBus', () => eventBusStub, {
        lifecycle: 'singleton',
        tags: ['event-bus', 'stub', 'test'],
        description: 'In-memory Event Bus stub for tests/setupContainer',
      });
    }

    if (!container.isRegistered('IEventStore')) {
       
      const { InMemoryEventStore } = require('../events/InMemoryEventStore') as typeof import('../events/InMemoryEventStore');
      container.register('IEventStore', () => new InMemoryEventStore(), {
        lifecycle: 'singleton',
        tags: ['event-store', 'stub', 'test', 'in-memory'],
        description: 'In-memory Event Store for tests/setupContainer',
      });
    }

    if (!container.isRegistered('IOutbox')) {
       
      const { InMemoryOutbox } = require('../events/InMemoryOutbox') as typeof import('../events/InMemoryOutbox');
      container.register('IOutbox', () => new InMemoryOutbox(), {
        lifecycle: 'singleton',
        tags: ['outbox', 'stub', 'test', 'in-memory'],
        description: 'In-memory Outbox for tests/setupContainer',
      });
    }

    if (!container.isRegistered('EventStoreService')) {
       
      const { registerEventStoreService } = require('../../application/di/bootstrap') as typeof import('../../application/di/bootstrap');
      registerEventStoreService(container);
    }

    return container;
  } finally {
    if (shouldQuiet) {
      restore();
    }
  }
}

export function createProductionContainer(): typeof container {
  return setupContainer({ environment: 'production', useInMemoryRepositories: false });
}

export function createDevelopmentContainer(): typeof container {
  return setupContainer({ environment: 'development', useInMemoryRepositories: false });
}

export function createTestContainer(): typeof container {
  return setupContainer({ environment: 'test', useInMemoryRepositories: true, quiet: true });
}
