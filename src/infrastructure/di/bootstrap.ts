/**
 * Composition root. This directory is the one place that may construct
 * application, presentation, and memory classes and register them.
 * Adapters outside src/infrastructure/di keep depending on ports.
 *
 * Infrastructure bootstrap orchestrator.
 * Выполняет только регистрацию модулей DI, проверку сервисов и запуск/остановку.
 */
import { container } from '../../core/di/container';
import { DI_TOKENS } from '../../core/di/DI_TOKENS';
import { getConfig } from '../../config';
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
import { registerEventServices as registerModuleEventServices } from './modules/events-llm.module';
import { registerRepositoryServices } from './modules/repositories.module';
import { registerApplicationServices } from './modules/application.module';
import { registerHttpModule } from './modules/http.module';
import { registerPlatformModule } from './modules/platform.module';
import { initializeHealthcareWorkers, registerHealthcareModule } from './modules/healthcare.module';
import { registerSecurityModule, registerSsrfDnsGuard } from './modules/security.module';
import { registerUserApprovalModule } from './modules/user-approval.module';
import { registerScientificSkillsServices } from './modules/scientific-skills.module';
import { registerSkillsServices, initializeSkillsServices } from './modules/skills.module';
import { registerContextServices } from './modules/context.module';
import { registerSmmuModule } from './modules/smmu.module';
import { registerSandboxServices, initializeSandboxServices, shutdownSandboxServices } from './modules/sandbox.module';
import {
  registerAgentRunnerServices,
  initializeAgentRunnerServices,
  shutdownAgentRunnerServices,
} from './modules/agent-runner.module';
import {
  registerServiceDiscoveryServices,
  initializeServiceDiscoveryServices,
  shutdownServiceDiscoveryServices,
} from './modules/service-discovery.module';
import { 
  registerInteractionCore,
  registerInteractionTools
} from './modules/interaction.module';
import { createIdentityRoutes } from '../../presentation/http/routes/identity.routes';
import { RegisterUserController } from '../../presentation/http/controllers/identity/RegisterUserController';
import { ProvisionTenantController } from '../../presentation/http/controllers/identity/ProvisionTenantController';
import { verifyCriticalInfrastructureServices } from './validation/service-verifier';
import { validateBootstrapContainer } from './validation/bootstrap-validation';
import type { IEventGapDetector } from '../../domain/events/event-gap-detector.interface';
import { createPostgresEventGapDetectorFromEnv } from '../events/postgres-event-gap-detector';
import { registerMcpCodeIntelligenceModule } from './modules/mcp-code-intelligence.module';
import { registerMcpContextModule } from './modules/mcp-context.module';
import { registerMcpDocsModule } from './modules/mcp-docs.module';
import { registerMcpExtractionModule } from './modules/mcp-extraction.module';
import { registerMcpAuditModule } from './modules/mcp-audit.module';
import { registerMcpSppModule } from './modules/mcp-spp.module';
import { registerMcpA2ABridgeModule } from './modules/mcp-a2a-bridge.module';
import { registerTemporalDecayModule } from './modules/temporal-decay.module';
import { registerTrajectoryLearningModule } from './modules/trajectory-learning.module';
import { registerLearningMemoryStoresModule } from './modules/learning-memory-stores.module';
import { registerSkillRelationGraphModule } from './modules/skill-relation-graph.module';
import { registerHookPipelineModule } from './modules/hook-pipeline.module';
import { registerTIMLspModule } from './modules/tim-lsp.module';
import { registerSemanticEmbeddingModule } from './modules/semantic-embedding.module';
import { initializeSemanticEmbeddingWorker } from './modules/semantic-embedding.module';
import { registerDebuggingModule } from './modules/debugging.module';
import {
  registerAgenticAdvanced,
  registerAgenticChains,
  registerAgenticCrossCutting,
  registerAgenticEvaluation,
  registerAgenticFoundation,
  registerAgenticInterAgent,
  registerAgenticPlanning,
  registerAgenticReasoning,
} from './modules/agentic.module';
import { registerSota2026MultiAgentModule } from './modules/sota-2026-multiagent.module';
import { getBootstrapLogger } from '../../core/logging/bootstrap-logger';
import { PluginAutoLoader } from '../plugins/PluginAutoLoader';
import { PluginLoader } from '../plugins/PluginLoader';
import { PluginLifecycleManager } from './plugin-container';
import { restoreTerminalState } from '../terminal/restore';

export { setupContainer, createProductionContainer, createDevelopmentContainer, createTestContainer } from './bootstrap.test-utils';
export { validateBootstrapContainer as validateBootstrapContainerRuntime, validateContainer } from './validation/bootstrap-validation';

export function registerEventGapDetectorService(): void {
  if (container.isRegistered('IEventGapDetector')) {
    return;
  }

  container.register<IEventGapDetector>(
    'IEventGapDetector',
    () => createPostgresEventGapDetectorFromEnv(),
    {
      lifecycle: 'singleton',
      tags: ['event-sourcing', 'infrastructure', 'postgresql', 'diagnostics'],
      description:
        'PostgreSQL Event Gap Detector for scanning GSN windows across Event Store and Outbox',
    },
  );
}

import { ConfigLoader } from '../../config/ConfigLoader';

const bootstrapLog = getBootstrapLogger('di-bootstrap');

// ... (imports)

export async function bootstrap(config: BootstrapConfig = {}): Promise<typeof container> {
  const startTime = process.hrtime.bigint();
  
  // Initialize ConfigLoader (DI-managed singleton)
  const configLoader = new ConfigLoader();
  const cfg = configLoader.load(); // Validates env vars immediately
  
  // Register ConfigLoader to DI as source of truth
  container.register(DI_TOKENS.IConfigLoader, () => configLoader, { lifecycle: 'singleton' });
  container.register('ConfigLoader', () => configLoader, { lifecycle: 'singleton' });

  const environment: 'production' | 'development' | 'test' =
    config.environment ?? cfg.env ?? 'development';
  const isTestEnvironment = environment === 'test';
  const initTimeoutMs = config.initTimeoutMs ?? 30000;
  const logInitialization = config.logInitialization ?? true;

  if (logInitialization) {
    bootstrapLog.info('Starting MicroPhoenix DI bootstrap', { environment });
  }

  const initTimeout = setTimeout(() => {
    throw new Error(`Bootstrap initialization timeout after ${initTimeoutMs}ms`);
  }, initTimeoutMs);

  try {
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
    registerDebuggingModule();
    registerSsrfDnsGuard();
    registerPlatformModule();
    
    // Register PluginLifecycleManager
    container.register('PluginLifecycleManager', (c) => new PluginLifecycleManager(
        c.resolve('ILogger')
    ), { lifecycle: 'singleton' });

    // Register IContainer (Self-binding for PluginLoader)
    container.register('IContainer', () => container, { lifecycle: 'singleton' });

    // Register PluginLoader
    container.register('PluginLoader', (c) => new PluginLoader(
        c.resolve('ILogger'),
        c.resolve('IPluginRegistry'),
        c.resolve('PluginLifecycleManager'),
        c.resolve('IContainer'),
        c.resolve('IToolRegistry')
    ), { lifecycle: 'singleton' });

    // Register PluginAutoLoader
    container.register('PluginAutoLoader', (c) => new PluginAutoLoader(
        c.resolve('PluginLoader'),
        c.resolve('ILogger')
    ), { lifecycle: 'singleton' });

    registerMemoryModuleServices();
    registerTemporalDecayModule();
    registerLearningMemoryStoresModule();
    registerTrajectoryLearningModule();
    registerTIMLspModule();
    registerSemanticEmbeddingModule();
    registerMasCoreModuleServices();
    await registerModuleEventServices();

    // In test-safe bootstrap paths, event services should remain in-memory and avoid DB schema init.
    if (!isTestEnvironment) {
      const { initializeEventServicesSchema } = await import('./modules/events-llm.module');
      await initializeEventServicesSchema();
    }

    registerEventGapDetectorService();
    registerContextServices();
    registerSmmuModule();
    registerModuleChatRuntime();
    registerRepositoryServices(Boolean(config.useInMemoryRepositories));
    registerHealthcareModule();
    registerScientificSkillsServices();
    registerSkillsServices();
    registerSkillRelationGraphModule();
    registerSandboxServices();
    registerAgentRunnerServices();
    registerServiceDiscoveryServices();
    registerInteractionCore(); // Must be before App Services
    registerHookPipelineModule(container); // IHookPipeline, IPluginSlotManager, PluginLifecycleService
    registerSecurityModule({ environment });
    registerUserApprovalModule();
    registerApplicationServices();
    await registerInteractionTools(); // Must be after App Services
    registerHttpModule();
    registerMcpCodeIntelligenceModule();
    registerMcpContextModule();
    registerMcpDocsModule();
    registerMcpExtractionModule();
    registerMcpAuditModule();
    registerMcpSppModule();
    registerMcpA2ABridgeModule();
    registerAgenticFoundation();
    registerAgenticReasoning();
    registerAgenticEvaluation();
    registerAgenticPlanning();
    registerAgenticChains();
    registerAgenticInterAgent();
    registerAgenticAdvanced();
    registerAgenticCrossCutting();
    registerSota2026MultiAgentModule();
    
    // Register Identity Controllers
    container.register('RegisterUserController', (c) => new RegisterUserController(
        c.resolve('RegisterUserUseCase'),
        c.resolve('ILogger')
    ));
    container.register('ProvisionTenantController', (c) => new ProvisionTenantController(
        c.resolve('ProvisionTenantUseCase'),
        c.resolve('ILogger')
    ));

    // Mount Identity Routes was moved to src/application/app.ts (createHttpApp)
    // to fix dependency injection cycle and ordering.

    await verifyCriticalInfrastructureServices();

    // Initialize Skills (Load and Register as Tools)
    await initializeSkillsServices();
    
    // Initialize sandbox services async
    try {
      await initializeSandboxServices();
    } catch (error) {
      bootstrapLog.warn('Sandbox initialization failed, continuing without sandbox', { error });
    }

    // Initialize agent runner services
    try {
      await initializeAgentRunnerServices();
    } catch (error) {
      bootstrapLog.warn('AgentRunner initialization failed, continuing without agent runner', { error });
    }

    // Initialize service discovery services
    try {
      await initializeServiceDiscoveryServices();
    } catch (error) {
      bootstrapLog.warn('Service Discovery initialization failed, continuing without service discovery', { error });
    }

    // Initialize semantic embedding worker (background vectorization)
    await initializeSemanticEmbeddingWorker();

    // Initialize healthcare workers (ingestion + async delivery)
    await initializeHealthcareWorkers();

    // Initialize Plugins
    try {
        const pluginLoader = container.resolve<PluginAutoLoader>('PluginAutoLoader');
        await pluginLoader.initialize();
    } catch (error) {
        bootstrapLog.warn('Plugin Auto-Loader failed, continuing without plugins', { error });
    }

    validateBootstrapContainer(environment, logInitialization);

    const initTimeMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    if (logInitialization) {
      bootstrapLog.info('DI bootstrap completed', {
        initTimeMs: Number(initTimeMs.toFixed(2)),
        registeredServices: container.getAllServices().length,
      });
    }

    return container;
  } catch (error) {
    bootstrapLog.error('Bootstrap failed', { error });
    throw error;
  } finally {
    clearTimeout(initTimeout);
  }
}

export async function shutdown(): Promise<void> {
  bootstrapLog.info('Starting graceful shutdown');
  try {
    // Shutdown agent runner first (to stop accepting new tasks)
    await shutdownAgentRunnerServices();

    // Shutdown service discovery (deregister services)
    await shutdownServiceDiscoveryServices();

    // Shutdown sandbox services
    await shutdownSandboxServices();

    // Only close services that have been instantiated (singletons that were resolved)
    const services = container.getAllServices();
    for (const service of services) {
      // Skip services that haven't been instantiated yet
      if (!container.isInstantiated(service.token)) {
        continue;
      }

      try {
        const instance = container.resolve(service.token);
        // Handle services with .close() (EventBus, EventStore, Outbox, etc.)
        const instanceWithClose = instance as { close?: () => Promise<void> };
        if (instanceWithClose && typeof instanceWithClose.close === 'function') {
          await instanceWithClose.close();
          // @audit-ok: shutdown-only — runs once during graceful shutdown
          bootstrapLog.info('Closed service during shutdown', { token: String(service.token) });
          continue;
        }
        // Handle services with .stop() (HttpServer, MetricsServer, etc.)
        const instanceWithStop = instance as { stop?: () => Promise<void> };
        if (instanceWithStop && typeof instanceWithStop.stop === 'function') {
          await instanceWithStop.stop();
          bootstrapLog.info('Stopped service during shutdown', { token: String(service.token) });
        }
      } catch (error) {
        bootstrapLog.error('Failed to close service during shutdown', {
          token: String(service.token),
          error,
        });
      }
    }
    container.clear();
    bootstrapLog.info('Graceful shutdown completed');
    restoreTerminalState('shutdown');
  } catch (error) {
    bootstrapLog.error('Shutdown failed', { error });
    restoreTerminalState('shutdown-error');
    throw error;
  }
}

export default bootstrap;
