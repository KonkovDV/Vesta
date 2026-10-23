/**
 * Application Layer DI Bootstrap
 * Layer: Application
 * 
 * Регистрация Use Cases и Application Services в DI контейнере.
 * Использует только интерфейсы из Domain/Core — НЕТ зависимостей от Infrastructure.
 */

import { FeatureFlagsService, createFeatureFlagsService } from '../services/FeatureFlagsService';
import { createAgentRunServiceFromTokens } from '../agents/create-agent-run-service';
import { FeatureFlagsManagementService } from '../services/FeatureFlagsManagementService';
import { DIContainer } from '../../core/di/container';
import { DI_TOKENS } from '../../core/di/DI_TOKENS';
import path from 'path';
import type { IConversationRepository } from '../../domain/conversation/IConversationRepository';
import type IMetricsPort from '../../domain/metrics/IMetricsPort';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IUserRepository } from '../../domain/identity/IUserRepository';
import type { ITenantRepository } from '../../domain/identity/ITenantRepository';
import type { IAdaptiveMemoryRetrieval } from '../../domain/memory/IAdaptiveMemoryRetrieval';
import type { IUserFeedbackCollector } from '../../domain/feedback/user-feedback-collector.interface';

function resolveApplicationWorkspaceRoot(): string {
  return path.resolve(__dirname, '../../..');
}

import type { IFeatureFlagsStore } from '../../domain/feature-flags/IFeatureFlagsStore';
import type { ICache } from '../../domain/cache/ICache';
import type { IFeatureManager } from '../../domain/features/IFeatureManager';
import { DefaultFeatureManager } from '../../domain/features/DefaultFeatureManager';
import { FEATURE_FLAGS_CONFIG } from '../../domain/features/FeatureFlagsConfig';
import { FeatureStrategyRegistry } from '../../domain/features/strategies/FeatureStrategyRegistry';
import { PercentageStrategy } from '../../domain/features/strategies/PercentageStrategy';
import { RegionStrategy } from '../../domain/features/strategies/RegionStrategy';
import { TimeWindowStrategy } from '../../domain/features/strategies/TimeWindowStrategy';
import { AbTestStrategy } from '../../domain/features/strategies/AbTestStrategy';
import { EventStoreService } from '../services/EventStoreService';
import { EventBusService } from '../services/EventBusService';
import { ConversationService } from '../../domain/services/ConversationService';
import { FileProcessingService } from '../../domain/services/FileProcessingService';
import { ChatService } from '../../domain/services/ChatService';
import { LLMBackedChatService } from '../services/LLMBackedChatService';
import { readStr } from '../../core/config/app-config';
import { SecurityAspect } from '../../core/aop/SecurityAspect';
import type { IAuthService } from '../../core/auth/IAuthService';
import { AuthService } from '../services/AuthService';
import { ApiKeyService } from '../services/ApiKeyService';
import type { HealthCheckService } from '../services/HealthCheckService';
import type { SlackIntegrationPort } from '../../domain/integrations/slack/slack-port';
import { SlackSlashCommandUseCase } from '../integrations/slack/slack-slash-command.usecase';
import { CachedFeatureManager } from '../features/CachedFeatureManager';
import { MetricsFeatureEvaluationObserver } from '../features/MetricsFeatureEvaluationObserver';
import {
  POLICY_ENGINE_DI_TOKEN,
  NoopPolicyEngine,
  type IPolicyEngine,
} from '../security/policy-engine';
import { MasPolicyService } from '../agents/security/mas-policy-service';
import type { IPluginManifestStore } from '../../domain/plugins/manifest/plugin-manifest-store.interface';
import { ManifestPolicyEnforcer, type IManifestPolicyEnforcer } from '../plugins/manifest-policy.enforcer';
import { registerPluginRuntimeServices } from '../plugins/unified-plugin-registry.di';
 
  // MAS Runtime Core (Application layer)
  import {
   masterAgentToken,
   type IMasterAgent,
  } from '../agents/core/master-agent';
  import {
   contextCoordinatorToken,
   type IContextCoordinator,
  } from '../agents/core/context-coordinator';
  import {
   taskDecomposerToken,
   type ITaskDecomposer,
  } from '../agents/core/task-decomposer';
  import {
   agentRegistryToken,
   type IAgentRegistry,
  } from '../agents/core/agent-registry';
  import {
    executionStrategyToken,
    type IExecutionStrategy,
  } from '../agents/core/execution-strategy';
  import type { MasDurableExecutionService } from '../../domain/mas/services/MasDurableExecutionService';
  import {
    masRuntimePolicyServiceToken,
    type IMasRuntimePolicyService,
    createMasRuntimePolicyService,
  } from '../agents/core/mas-runtime-policy.service';
  import {
    masSessionStoreToken,
    type IMasSessionStore,
  } from '../agents/state/mas-session-store';
  import { MasterAgentV1 } from '../agents/impl/master-agent-v1';
  import { ContextCoordinatorV1 } from '../agents/impl/context-coordinator-v1';
  import { TaskDecomposerV1 } from '../agents/impl/task-decomposer-v1';
  import { AgentRegistryStaticV1 } from '../agents/impl/agent-registry-static-v1';
  import { SequentialExecutionStrategy } from '../agents/impl/execution-strategy-sequential';
 import type { ISessionMemoryManager } from '../../domain/memory/ISessionMemoryManager';
  import { MasMemoryAdapterV1 } from '../agents/memory/mas-memory.adapter';
  import type { IMasMemoryPort } from '../agents/memory/mas-memory.port';
  import { MasGeneratePlanUseCase } from '../mas/usecases/mas-generate-plan.usecase';
  import { MasAdvancedRetrievalFacade } from '../agents/memory/mas-advanced-retrieval.facade';

/**
 * Module feature flag: defaults to enabled unless explicitly set to 'false'.
 * Usage: MODULE_RESEARCH_ENABLED=false, MODULE_HEALTHCARE_ENABLED=false
 */
function isModuleEnabled(envKey: string): boolean {
  const value = (readStr(envKey, 'true') ?? 'true').toLowerCase();
  return value !== 'false' && value !== '0';
}
import type { IAppFactory } from '../../core/contracts/IAppFactory';
import type { HttpAppDependencies } from '../app';
import { ChatController } from '../controllers/chatController';
import { ConversationController } from '../controllers/ConversationController';
import { PluginController } from '../controllers/PluginController';
import { SlackEntController } from '../controllers/slackEntController';
import { MemorySearchController } from '../controllers/memorySearchController';
import { MasController } from '../controllers/masController';
import { McpApprovalsController } from '../controllers/McpApprovalsController';
import type { IUnifiedPluginRegistry } from '../plugins/unified-plugin-registry';
import { PluginRuntimeServiceTokens } from '../plugins/unified-plugin-registry.di';
import { ToolPolicyService } from '../security/ToolPolicyService';

//  Use Cases
  import {
    CreateConversationUseCase,
    GetConversationUseCase,
    AddParticipantUseCase,
    ArchiveConversationUseCase,
    SendMessageUseCase,
    UpdateConversationUseCase,
    ListConversationsUseCase,
    DeleteConversationUseCase,
    ExportConversationsUseCase,
    ImportConversationsUseCase,
    UploadFileUseCase,
  } from '../usecases/conversations';
  import { MultimodalIngestUseCase } from '../memory/multimodal-ingest.usecase';
  import { RagQueryService } from '../memory/rag-query.service';
  import { SemanticSearchUseCase } from '../memory/semantic-search.usecase';
  import { KnowledgeBaseIngestUseCase } from '../memory/knowledge-base-ingest.usecase';
  import { AdvancedRetrievalUseCase } from '../memory/advanced-retrieval.usecase';
  import type { HybridMemoryRetrievalService } from '../../memory/retrieval/hybrid-memory-retrieval.service';
  import type { HSGClient } from '../../domain/memory/session-memory-ports';
 
 /**
  * Токены для Application Use Cases
  */
export const ApplicationServiceTokens = {
  // Conversation Use Cases
  CREATE_CONVERSATION: 'CreateConversationUseCase',
  GET_CONVERSATION: 'GetConversationUseCase',
  ADD_PARTICIPANT: 'AddParticipantUseCase',
  ARCHIVE_CONVERSATION: 'ArchiveConversationUseCase',
  SEND_MESSAGE: 'SendMessageUseCase',
  // File & Export/Import Use Cases
  EXPORT_CONVERSATIONS: 'ExportConversationsUseCase',
  IMPORT_CONVERSATIONS: 'ImportConversationsUseCase',
  UPLOAD_FILE: 'UploadFileUseCase',
  UPDATE_CONVERSATION: 'UpdateConversationUseCase',
  LIST_CONVERSATIONS: 'ListConversationsUseCase',
  DELETE_CONVERSATION: 'DeleteConversationUseCase',
 
  // Memory / Multimodal Use Cases
  MULTIMODAL_INGEST: 'MultimodalIngestUseCase',
  SEMANTIC_SEARCH: 'SemanticSearchUseCase',
  KNOWLEDGE_BASE_INGEST: 'KnowledgeBaseIngestUseCase',
  ADVANCED_RETRIEVAL: 'AdvancedRetrievalUseCase',
 
  // MAS Application Use Cases
  MAS_GENERATE_PLAN: 'MasGeneratePlanUseCase',
  MAS_ADVANCED_RETRIEVAL: 'MasAdvancedRetrievalFacade',

  // Research / Education Use Cases
  RESEARCH_ASSISTANCE: 'ResearchAssistanceUseCase',

  // Identity Use Cases
  REGISTER_USER: 'RegisterUserUseCase',
  PROVISION_TENANT: 'ProvisionTenantUseCase',

  // Sales Use Cases
  LEAD_SCORING: 'LeadScoringUseCase',
  SALES_FORECASTING: 'SalesForecastingUseCase',

  // HR Use Cases
  TALENT_ACQUISITION: 'TalentAcquisitionUseCase',
  EMPLOYEE_ENGAGEMENT: 'EmployeeEngagementUseCase',

  // Healthcare Use Cases
  DIAGNOSIS_SUPPORT: 'DiagnosisSupportUseCase',
  GENERATE_MRI_SECOND_OPINION: 'GenerateMriSecondOpinionUseCase',
  COMPLETE_MRI_HUMAN_REVIEW: 'CompleteMriHumanReviewUseCase',
  FINALIZE_MRI_SECOND_OPINION: 'FinalizeMriSecondOpinionUseCase',
  
  // Plugin manifest / policy enforcement
  MANIFEST_POLICY_ENFORCER: 'IManifestPolicyEnforcer',
 } as const;

/**
 * Регистрация доменных сервисов (без зависимостей от Infrastructure)
 */
export function registerEventStoreService(container: DIContainer): void {
  if (!container.isRegistered('EventStoreService')) {
    container.register(
      'eventStoreService',
      (c) => {
        const eventStore = c.resolve<import('../../domain/events/event-store.interface').IEventStore>('IEventStore');
        const outbox = c.resolve<import('../../domain/events/outbox.interface').IOutbox>('IOutbox');
        return new EventStoreService(eventStore, outbox);
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'event-store'],
        description: 'Application Event Store Service',
      }
    );
  }

  if (!container.isRegistered('EventStoreService')) {
    container.register('EventStoreService', () => container.resolve('eventStoreService'), {
      lifecycle: 'singleton',
      tags: ['application', 'event-store', 'alias'],
      description: 'Backward-compatible alias for eventStoreService',
    });
  }
}

export function registerDomainServices(container: DIContainer): void {
  if (!container.isRegistered('ApiKeyService')) {
    container.register(
      'apiKeyService',
      (c) => {
        const repository = c.resolve<import('../../domain/auth/IApiKeyRepository').IApiKeyRepository>(
          'IApiKeyRepository',
        );
        const cache = c.isRegistered('ICache')
          ? c.resolve<import('../../domain/cache/ICache').ICache>('ICache')
          : undefined;
        return new ApiKeyService(repository, cache);
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'auth', 'api-keys'],
        description: 'Secure API key store service over IApiKeyRepository and ICache',
      },
    );
  }

  // AuthService / IAuthService
  if (!container.isRegistered('AuthService')) {
    container.register(
      'authService',
      (c) => {
        const apiKeyService = c.isRegistered('ApiKeyService')
          ? c.resolve<ApiKeyService>('ApiKeyService')
          : undefined;
        const logger = c.isRegistered('ILogger')
          ? c.resolve<ILogger>('ILogger')
          : undefined;
        return new AuthService(apiKeyService, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'auth'],
        description: 'BFF AuthService implementing IAuthService core contract',
      },
    );
  }

  if (!container.isRegistered('IAuthService')) {
    container.register('IAuthService', () => container.resolve<AuthService>('authService'), {
      lifecycle: 'singleton',
      tags: ['application', 'auth', 'contract'],
      description: 'IAuthService bound to AuthService',
    });
  }

  if (!container.isRegistered('AuthService')) {
    container.register('AuthService', () => container.resolve<AuthService>('authService'), {
      lifecycle: 'singleton',
      tags: ['application', 'auth', 'alias'],
      description: 'Backward-compatible alias for authService',
    });
  }

  if (!container.isRegistered(DI_TOKENS.SecurityAspect)) {
    container.register(
      DI_TOKENS.SecurityAspect,
      (c) => new SecurityAspect(c.resolve<IAuthService>('IAuthService'), {
        bypass: (context) => {
          const firstArg = context.args[0];
          const hasExpressHandlerShape =
            context.args.length >= 2 &&
            firstArg !== null &&
            typeof firstArg === 'object' &&
            'headers' in firstArg;
          if (hasExpressHandlerShape) {
            return true;
          }
          if (!firstArg || typeof firstArg !== 'object') {
            return true;
          }
          const candidate = firstArg as { token?: unknown; authToken?: unknown };
          return typeof candidate.token !== 'string' && typeof candidate.authToken !== 'string';
        },
      }),
      {
        lifecycle: 'transient',
        tags: ['aop', 'security'],
        description: 'Cross-cutting security aspect for token-bearing invocations',
      },
    );
  }

  if (!container.isRegistered('RateLimitService')) {
    container.register(
      'rateLimitService',
      (c) => {
        const cache =
          c.resolve<import('../../domain/cache/ICache').ICache>('ICache');
        const auth = c.isRegistered('authService')
          ? c.resolve<AuthService>('authService')
          : undefined;
        const logger = c.isRegistered('ILogger')
          ? c.resolve<ILogger>('ILogger')
          : undefined;
        // Lazy require to avoid cycles if any
        const { RateLimitService } =
          require('../services/RateLimitService') as typeof import('../services/RateLimitService');
        return new RateLimitService(cache, auth, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'rate-limit'],
        description: 'Rate Limit Service for BFF API',
      }
    );
  }

  if (!container.isRegistered('RateLimitService')) {
    container.register('RateLimitService', () => container.resolve('rateLimitService'), {
      lifecycle: 'singleton',
      tags: ['application', 'rate-limit', 'alias'],
      description: 'Backward-compatible alias for rateLimitService',
    });
  }

  if (!container.isRegistered('ConversationService')) {
    container.register(
      'conversationService',
      (c) => {
        const repository = c.resolve<IConversationRepository>('IConversationRepository');
        return new ConversationService(repository);
      },
      {
        lifecycle: 'singleton',
        tags: ['domain', 'service'],
        description:
          'ConversationService backed by IConversationRepository (TASK-008, no in-memory Map)',
      },
    );
  }

  if (!container.isRegistered('ConversationService')) {
    container.register('ConversationService', () => container.resolve('conversationService'), {
      lifecycle: 'singleton',
      tags: ['domain', 'service', 'alias'],
      description: 'Backward-compatible alias for conversationService',
    });
  }

  if (!container.isRegistered('fileProcessingService')) {
    container.register('fileProcessingService', () => new FileProcessingService(), {
      lifecycle: 'singleton',
      tags: ['domain', 'service'],
      description: 'FileProcessingService stub',
    });
  }

  if (!container.isRegistered('FileProcessingService')) {
    container.register('FileProcessingService', () => container.resolve('fileProcessingService'), {
      lifecycle: 'singleton',
      tags: ['domain', 'service', 'alias'],
      description: 'Backward-compatible alias for fileProcessingService',
    });
  }

  if (!container.isRegistered('HealthCheckService')) {
    container.register(
      'healthCheckService',
      (c) => {
        // Lazy require
        const { HealthCheckService } = require('../services/HealthCheckService');
        return new HealthCheckService(
          c.resolve('IEventStore'),
          c.resolve('IEventBus'),
          c.resolve('IOutbox'),
          c.resolve('FeatureFlagsService'),
          c.resolve('rateLimitService'),
          c.isRegistered('IAIClient') ? c.resolve('IAIClient') : undefined,
        );
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'health'],
        description: 'Health Check Service',
      }
    );
  }

  if (!container.isRegistered('HealthCheckService')) {
    container.register('HealthCheckService', () => container.resolve('healthCheckService'), {
      lifecycle: 'singleton',
      tags: ['application', 'health', 'alias'],
      description: 'Backward-compatible alias for healthCheckService',
    });
  }

  if (!container.isRegistered('FeatureStrategyRegistry')) {
    container.register(
      'featureStrategyRegistry',
      () => {
        const registry = new FeatureStrategyRegistry();
        registry.register(new PercentageStrategy());
        registry.register(new RegionStrategy());
        registry.register(new TimeWindowStrategy());
        registry.register(new AbTestStrategy());
        return registry;
      },
      {
        lifecycle: 'singleton',
        tags: ['feature-flags', 'strategy-registry', 'domain'],
        description:
          'Domain feature flags strategy registry (Percentage/Region/TimeWindow/AbTest)',
      }
    );
  }

  if (!container.isRegistered('IFeatureManagerBase')) {
    container.register<IFeatureManager>(
      'IFeatureManagerBase',
      (c) => {
        const store = c.resolve<IFeatureFlagsStore>('IFeatureFlagsStore');
        const strategyRegistry = c.resolve<FeatureStrategyRegistry>('featureStrategyRegistry');

        return new DefaultFeatureManager({
          store,
          strategyRegistry,
          defaultFlags: FEATURE_FLAGS_CONFIG.defaultFlags,
          metadata: FEATURE_FLAGS_CONFIG.metadata,
        });
      },
      {
        lifecycle: 'singleton',
        tags: ['feature-flags', 'manager', 'domain', 'base'],
        description: 'Base domain feature manager without caching/metrics',
      }
    );
  }

  if (!container.isRegistered('IFeatureManager')) {
    container.register<IFeatureManager>(
      'IFeatureManager',
      (c) => {
        const store = c.resolve<IFeatureFlagsStore>('IFeatureFlagsStore');
        const strategyRegistry = c.resolve<FeatureStrategyRegistry>('featureStrategyRegistry');
        const cache = c.isRegistered('ICache') ? c.resolve<ICache>('ICache') : undefined;
        const metrics = c.isRegistered('IMetricsPort')
          ? c.resolve<IMetricsPort>('IMetricsPort')
          : undefined;

        const observer = new MetricsFeatureEvaluationObserver({
          metricsPort: metrics,
        });

        const baseManager = new DefaultFeatureManager({
          store,
          strategyRegistry,
          observer,
          defaultFlags: FEATURE_FLAGS_CONFIG.defaultFlags,
          metadata: FEATURE_FLAGS_CONFIG.metadata,
        });

        if (!cache) {
          return baseManager;
        }

        return new CachedFeatureManager({
          inner: baseManager,
          cache,
        });
      },
      {
        lifecycle: 'singleton',
        tags: ['feature-flags', 'manager', 'application'],
        description:
          'Application-level feature manager with metrics observer and cache decorator',
      }
    );
  }

  if (!container.isRegistered('FeatureFlagsService')) {
    container.register(
      'featureFlagsService',
      (c) =>
        createFeatureFlagsService({
          // ВАЖНО:
          // - Здесь мы резолвим только доменные/infra контракты по токенам DI.
          // - Application-слой не импортирует инфраструктурные реализации напрямую.
          redis: c.isRegistered('ICache')
            ? c.resolve<ICache>('ICache')
            : undefined,
          store: c.isRegistered('IFeatureFlagsStore')
            ? (c.resolve('IFeatureFlagsStore'))
            : undefined,
          metrics: c.isRegistered('IMetricsPort')
            ? (c.resolve('IMetricsPort'))
            : undefined,
          logger: c.isRegistered('ILogger')
            ? c.resolve<ILogger>('ILogger')
            : undefined,
          featureManager: c.isRegistered('IFeatureManager')
            ? c.resolve<IFeatureManager>('IFeatureManager')
            : undefined,
        }),
      {
        lifecycle: 'singleton',
        tags: ['application', 'feature-flags'],
        description: 'Application-layer Feature Flags Service (uses core types only)',
      }
    );
  }

  // Alias for PascalCase token compatibility
  if (!container.isRegistered('FeatureFlagsService')) {
    container.register(
      'FeatureFlagsService',
      (c) => c.resolve<FeatureFlagsService>('featureFlagsService'),
      {
        lifecycle: 'singleton',
        tags: ['application', 'feature-flags', 'alias'],
        description: 'FeatureFlagsService alias (PascalCase)',
      }
    );
  }

  if (!container.isRegistered('FeatureFlagsManagementService')) {
    container.register(
      'featureFlagsManagementService',
      (c) => new FeatureFlagsManagementService(c.resolve('featureFlagsService')),
      {
        lifecycle: 'singleton',
        tags: ['application', 'feature-flags', 'management'],
        description: 'High-level feature flags management service (bulk updates, profiles)',
      }
    );
  }

  registerEventStoreService(container);

  if (!container.isRegistered('EventBusService')) {
    container.register(
      'eventBusService',
      (c) => {
        const eventBus = c.resolve<import('../../domain/events/event-bus.interface').IEventBus>(DI_TOKENS.IEventBus);
        const outbox = c.isRegistered(DI_TOKENS.IOutbox)
          ? c.resolve<import('../../domain/events/outbox.interface').IOutbox>(DI_TOKENS.IOutbox)
          : undefined;
        return new EventBusService(eventBus, outbox);
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'event-bus'],
        description: 'Application Event Bus Service',
      }
    );
  }

  if (!container.isRegistered('EventBusService')) {
    container.register('EventBusService', () => container.resolve('eventBusService'), {
      lifecycle: 'singleton',
      tags: ['application', 'event-bus', 'alias'],
      description: 'Backward-compatible alias for eventBusService',
    });
  }

  // ChatService:
  // - продовая LLM-backed реализация регистрируется в infra/di/bootstrap.ts (через LLMAdapterFactory) при включенном feature-флаге;
  // - здесь регистрируем только безопасный stub, и только если infra не предоставила свою реализацию.
  if (!container.isRegistered('chatService')) {
    container.register('chatService', () => {
      if (readStr('NODE_ENV', 'development') !== 'test') {
        console.warn(
          '⚠️ [ChatService] Stub implementation is active. Responding with hardcoded messages. Do not use in production!',
        );
      }
      return new ChatService();
    }, {
      lifecycle: 'singleton',
      tags: ['domain', 'service', 'chat', 'stub'],
      description:
        'Stub ChatService for BFF compatibility; real LLM wiring is provided by infra bootstrap under feature flag',
    });
  }

  if (!container.isRegistered('ChatService')) {
    container.register('ChatService', () => container.resolve('chatService'), {
      lifecycle: 'singleton',
      tags: ['domain', 'service', 'chat', 'alias'],
      description: 'Backward-compatible alias for chatService',
    });
  }

  // Интерфейсный DI-токен для ChatService, чтобы Application/UseCases могли ссылаться
  // на абстракцию 'IChatService', а не на конкретный класс/токен 'ChatService'.
  // В production 'ChatService' переопределяется на LLMBackedChatService в infra-bootstrap,
  // и этот alias автоматически начинает указывать на продовую реализацию.
  if (!container.isRegistered('IChatService')) {
    container.register(
      'IChatService',
      () => container.resolve<ChatService>('chatService'),
      {
        lifecycle: 'singleton',
        tags: ['domain', 'service', 'chat', 'alias'],
        description:
          'IChatService alias token bound to ChatService (stub or LLM-backed via infra bootstrap)',
      },
    );
  }

  if (!container.isRegistered('SlackSlashCommandUseCase')) {
    container.register(
      'SlackSlashCommandUseCase',
      (c) => {
        const slackPort = c.resolve<SlackIntegrationPort>('SlackIntegrationPort');
        const chatService = c.resolve<ChatService>('chatService');
        return new SlackSlashCommandUseCase(slackPort, chatService);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'integration', 'slack'],
        description: 'Slack slash-command use-case with LLM-first flow and echo fallback',
      },
    );
  }

  if (!container.isRegistered(POLICY_ENGINE_DI_TOKEN)) {
    container.register(
      POLICY_ENGINE_DI_TOKEN,
      () => new NoopPolicyEngine(),
      {
        lifecycle: 'singleton',
        tags: ['security', 'policy', 'noop'],
        description:
          'NoopPolicyEngine stub used when no real PolicyEngine is registered in infrastructure bootstrap',
      },
    );
  }

  if (!container.isRegistered('MasPolicyService')) {
    container.register(
      'MasPolicyService',
      (c) => {
        const engine = c.resolve<IPolicyEngine>(POLICY_ENGINE_DI_TOKEN);
        return new MasPolicyService(engine);
      },
      {
        lifecycle: 'singleton',
        tags: ['mas', 'policy', 'application'],
        description: 'MAS preflight Policy service over shared IPolicyEngine',
      },
    );
  }

  if (!container.isRegistered('IToolExecutionPolicy')) {
    container.register(
      'IToolExecutionPolicy',
      (c) =>
        new ToolPolicyService(
          c.resolve<ILogger>(DI_TOKENS.ILogger),
          c.resolve<import('../../domain/security/tool-policy-resolver.port').IToolPolicyResolver>(DI_TOKENS.IToolPolicyResolver),
        ),
      {
        lifecycle: 'singleton',
        tags: ['security', 'policy', 'application'],
        description: 'Tool Execution Firewall Policy (App Layer)',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.MANIFEST_POLICY_ENFORCER)) {
    container.register<IManifestPolicyEnforcer>(
      ApplicationServiceTokens.MANIFEST_POLICY_ENFORCER,
      (c) => {
        const store = c.resolve<IPluginManifestStore>('IPluginManifestStore');
        return new ManifestPolicyEnforcer(store);
      },
      {
        lifecycle: 'singleton',
        tags: ['plugins', 'manifest', 'policy'],
        description: 'Core ManifestPolicyEnforcer for plugin manifest v2 runtime',
      },
    );
  }

  // AppFactory → IAppFactory binding for Core orchestrator.
  // Core вызывает container.resolve('AppFactory') и не знает про Express.
  if (!container.isRegistered('AppFactory')) {
    container.register<IAppFactory>(
      'appFactory',
      (c) => {
        const authService = c.resolve<AuthService>('authService');
        const rateLimitService = c.resolve<import('../services/RateLimitService').RateLimitService>('rateLimitService');
        const healthCheckService = c.resolve<HealthCheckService>('healthCheckService');
        const featureFlagsService = c.resolve<FeatureFlagsService>('featureFlagsService');
        const logger = c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined;

        const eventStoreService = c.resolve<EventStoreService>('eventStoreService');
        const ragQueryService = c.resolve<RagQueryService>(RAG_QUERY_SERVICE_DI_TOKEN);

        const chatService = c.resolve<ChatService>('chatService');
        const conversationService = c.resolve<ConversationService>('conversationService');
        const fileProcessingService = c.resolve<FileProcessingService>('fileProcessingService');

        const sendMessageUseCase = c.resolve<SendMessageUseCase>(ApplicationServiceTokens.SEND_MESSAGE);
        const createConversationUseCase = c.resolve<CreateConversationUseCase>(ApplicationServiceTokens.CREATE_CONVERSATION);
        const getConversationUseCase = c.resolve<GetConversationUseCase>(ApplicationServiceTokens.GET_CONVERSATION);
        const updateConversationUseCase = c.resolve<UpdateConversationUseCase>(ApplicationServiceTokens.UPDATE_CONVERSATION);
        const archiveConversationUseCase = c.resolve<ArchiveConversationUseCase>(ApplicationServiceTokens.ARCHIVE_CONVERSATION);
        const listConversationsUseCase = c.resolve<ListConversationsUseCase>(ApplicationServiceTokens.LIST_CONVERSATIONS);
        const deleteConversationUseCase = c.resolve<DeleteConversationUseCase>(ApplicationServiceTokens.DELETE_CONVERSATION);
        const exportConversationsUseCase = c.resolve<ExportConversationsUseCase>(ApplicationServiceTokens.EXPORT_CONVERSATIONS);
        const importConversationsUseCase = c.resolve<ImportConversationsUseCase>(ApplicationServiceTokens.IMPORT_CONVERSATIONS);
        const uploadFileUseCase = c.resolve<UploadFileUseCase>(ApplicationServiceTokens.UPLOAD_FILE);
        const semanticSearchUseCase = c.resolve<SemanticSearchUseCase>(ApplicationServiceTokens.SEMANTIC_SEARCH);

        const masGeneratePlanUseCase = c.resolve<MasGeneratePlanUseCase>(ApplicationServiceTokens.MAS_GENERATE_PLAN);
        const masAdvancedRetrievalFacade = c.resolve<MasAdvancedRetrievalFacade>(ApplicationServiceTokens.MAS_ADVANCED_RETRIEVAL);

        const masterAgent = c.resolve<IMasterAgent>(masterAgentToken);
        const masPolicyService = c.resolve<MasPolicyService>('MasPolicyService');

        const slackSlashCommandUseCase = c.resolve<SlackSlashCommandUseCase>('SlackSlashCommandUseCase');

        const chatController = c.resolve<ChatController>('ChatController');
        const conversationController = c.resolve<ConversationController>('ConversationController');
        const pluginController = c.resolve<PluginController>('PluginController');
        const slackEntController = c.resolve<SlackEntController>('SlackEntController');
        const memorySearchController = c.resolve<MemorySearchController>('MemorySearchController');
        const masController = c.resolve<MasController>('MasController');
        const mcpApprovalsController = c.resolve<McpApprovalsController>('McpApprovalsController');

        const deps: HttpAppDependencies = {
          authService,
          rateLimitService,
          healthCheckService,
          featureFlagsService,
          logger,
          chatController,
          conversationController,
          pluginController,
          slackEntController,
          memorySearchController,
          masController,
          mcpApprovalsController,
          ragQueryService,
          masAdvancedRetrievalFacade,
          masterAgent,
          masPolicyService,
          eventStoreService,
          agentRuns: createAgentRunServiceFromTokens(c),
          workspaceRoot: resolveApplicationWorkspaceRoot(),
          registerRoutes: c.isRegistered('HttpRouteRegistrar')
            ? c.resolve<import('../app').HttpRouteRegistrar>('HttpRouteRegistrar')
            : () => undefined,
        };

        const appFactory: IAppFactory = {
          createApp: async () => {
            // Lazy require to avoid circular dependency (app.ts <-> di/bootstrap.ts)
             
            const { createHttpApp } = require('../app') as typeof import('../app');
            const app = createHttpApp(deps);
            return { app };
          },
        };

        return appFactory;
      },
    );
  }

  // Alias for PascalCase token compatibility (HttpModule uses AppFactory)
  if (!container.isRegistered('AppFactory')) {
    container.register<IAppFactory>(
      'AppFactory',
      (c) => c.resolve<IAppFactory>('appFactory'),
      {
        lifecycle: 'singleton',
        tags: ['application', 'factory', 'http', 'alias'],
        description: 'AppFactory alias (PascalCase)',
      }
    );
  }
}

/**
 * Регистрация Conversation Use Cases
 * 
 * Требует наличия в контейнере:
 * - 'IConversationRepository' (регистрируется в Infrastructure)
 * - 'IOutbox' (регистрируется в Infrastructure)
 */
export function registerConversationUseCases(container: DIContainer): void {
  // Use Cases с событиями требуют repo + outbox
  container.register(
    ApplicationServiceTokens.CREATE_CONVERSATION,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      const eventStore = container.resolve<EventStoreService>('eventStoreService');
      const eventBus = container.resolve<EventBusService>('eventBusService');
      return new CreateConversationUseCase(repo, eventStore, eventBus);
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  container.register(
    ApplicationServiceTokens.ADD_PARTICIPANT,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      const eventStore = container.resolve<EventStoreService>('eventStoreService');
      const eventBus = container.resolve<EventBusService>('eventBusService');
      return new AddParticipantUseCase(repo, eventStore, eventBus);
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  container.register(
    ApplicationServiceTokens.ARCHIVE_CONVERSATION,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      const eventStore = container.resolve<EventStoreService>('eventStoreService');
      const eventBus = container.resolve<EventBusService>('eventBusService');
      return new ArchiveConversationUseCase(repo, eventStore, eventBus);
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  container.register(
    ApplicationServiceTokens.SEND_MESSAGE,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      const eventStore = container.resolve<EventStoreService>('eventStoreService');
      const eventBus = container.resolve<EventBusService>('eventBusService');
      
      // Resolve Cognitive Dependencies (Optional/Lazy)
      let processor;
      let runner;
      try {
          processor = container.resolve<import('../../domain/interaction/InboundContextProcessor').IInboundContextProcessor>('IInboundContextProcessor');
          runner = container.resolve<import('../../domain/agent-runner/agent-runner.port').IAgentRunner>('IAgentRunner');
      } catch (e) {
          console.warn('Cognitive dependencies missing for SendMessageUseCase, proceeding without agent loop.');
      }

      const logger = container.isRegistered('ILogger') 
        ? container.resolve<import('../../core/decorators/ILogger').ILogger>('ILogger') 
        : undefined;

      const adaptiveMemoryRetrieval = container.isRegistered(DI_TOKENS.IAdaptiveMemoryRetrieval)
        ? container.resolve<IAdaptiveMemoryRetrieval>(DI_TOKENS.IAdaptiveMemoryRetrieval)
        : undefined;

      const userFeedbackCollector = container.isRegistered(DI_TOKENS.IUserFeedbackCollector)
        ? container.resolve<IUserFeedbackCollector>(DI_TOKENS.IUserFeedbackCollector)
        : undefined;

      const dialogReply = container.isRegistered('IChatService')
        ? container.resolve<import('../usecases/conversations').DialogReplyGenerator>('IChatService')
        : undefined;

      const profileMemory = container.isRegistered(DI_TOKENS.IProfileMemory)
        ? container.resolve<import('../../domain/memory/IProfileMemory').IProfileMemory>(DI_TOKENS.IProfileMemory)
        : undefined;

      return new SendMessageUseCase(
        repo,
        eventStore,
        eventBus,
        processor,
        runner,
        logger,
        adaptiveMemoryRetrieval,
        userFeedbackCollector,
        dialogReply,
        profileMemory,
      );
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  // Use Cases без событий требуют только repo
  container.register(
    ApplicationServiceTokens.GET_CONVERSATION,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      return new GetConversationUseCase(repo);
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  container.register(
    ApplicationServiceTokens.UPDATE_CONVERSATION,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      return new UpdateConversationUseCase(repo);
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  container.register(
    ApplicationServiceTokens.LIST_CONVERSATIONS,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      return new ListConversationsUseCase(repo);
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  // Delete
  container.register(
    ApplicationServiceTokens.DELETE_CONVERSATION,
    () => {
      const repo = container.resolve<IConversationRepository>('IConversationRepository');
      return new DeleteConversationUseCase(repo);
    },
    { lifecycle: 'transient', tags: ['usecase', 'conversation'] }
  );

  // Export/Import Use Cases регистрация
  container.register(
    ApplicationServiceTokens.EXPORT_CONVERSATIONS,
    () => {
      const conversationService = container.resolve<ConversationService>('conversationService');
      return new ExportConversationsUseCase({
        exportConversations: (userId, options) =>
          conversationService.exportConversations(userId, options ?? {}),
      });
    },
    { lifecycle: 'transient', tags: ['usecase', 'export'] }
  );

  container.register(
    ApplicationServiceTokens.IMPORT_CONVERSATIONS,
    () => {
      const conversationService = container.resolve<ConversationService>('conversationService');
      return new ImportConversationsUseCase({
        importConversations: (userId, options) =>
          conversationService.importConversations(userId, options),
      });
    },
    { lifecycle: 'transient', tags: ['usecase', 'import'] }
  );

  container.register(
    ApplicationServiceTokens.UPLOAD_FILE,
    () => {
      const fileProcessingService = container.resolve<FileProcessingService>('fileProcessingService');
      return new UploadFileUseCase(fileProcessingService);
    },
    { lifecycle: 'transient', tags: ['usecase', 'upload'] }
  );
}

/**
 * Memory / Multimodal Use Cases
 */
export const RAG_QUERY_SERVICE_DI_TOKEN = 'RagQueryService' as const;
 
export function registerMemoryUseCases(container: DIContainer): void {
  if (!container.isRegistered(ApplicationServiceTokens.MULTIMODAL_INGEST)) {
    container.register(
      ApplicationServiceTokens.MULTIMODAL_INGEST,
      () => {
        const sessionMemoryManager = container.resolve<ISessionMemoryManager>('ISessionMemoryManager');
        return new MultimodalIngestUseCase(sessionMemoryManager);
      },
      { lifecycle: 'transient', tags: ['usecase', 'memory', 'multimodal'] },
    );
  }
 
  if (!container.isRegistered(RAG_QUERY_SERVICE_DI_TOKEN)) {
    container.register(
      RAG_QUERY_SERVICE_DI_TOKEN,
      (c) => {
        const retrievalService = c.resolve<HybridMemoryRetrievalService>(
          DI_TOKENS.hybridMemoryRetrievalService,
        );
        return new RagQueryService({ retrievalService });
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'memory', 'rag'],
        description:
          'Application-layer RAG query service over HybridMemoryRetrievalService (MEM-NEXT, read-only)',
      },
    );
  }
 
  if (!container.isRegistered(ApplicationServiceTokens.SEMANTIC_SEARCH)) {
    container.register(
      ApplicationServiceTokens.SEMANTIC_SEARCH,
      (c) => {
        const retrievalService = c.resolve<HybridMemoryRetrievalService>(
          DI_TOKENS.hybridMemoryRetrievalService,
        );
        return new SemanticSearchUseCase(retrievalService);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'memory', 'semantic-search'],
        description:
          'Semantic search use case over HybridMemoryRetrievalService (CODE-MEM-NEXT-STEP1)',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.ADVANCED_RETRIEVAL)) {
    container.register(
      ApplicationServiceTokens.ADVANCED_RETRIEVAL,
      (c) => {
        type AdvancedRetrievalService = import('../../domain/memory/AdvancedRetrievalService').AdvancedRetrievalService;
        const service = c.resolve<AdvancedRetrievalService>('AdvancedRetrievalService');
        // Lazy require to avoid hard coupling if file is moved/refactored.
         
        const { AdvancedRetrievalUseCase } = require('../memory/advanced-retrieval.usecase') as typeof import('../memory/advanced-retrieval.usecase');
        return new AdvancedRetrievalUseCase(service);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'memory', 'advanced-retrieval'],
        description:
          'Advanced retrieval use case over domain AdvancedRetrievalService (EV18.2 skeleton, vector-only by default)',
      },
    );
  }
 
  if (!container.isRegistered(ApplicationServiceTokens.KNOWLEDGE_BASE_INGEST)) {
    container.register(
      ApplicationServiceTokens.KNOWLEDGE_BASE_INGEST,
      (c) => {
        const hsgClient = c.resolve<HSGClient>('HSGClient');
        return new KnowledgeBaseIngestUseCase({ hsgClient });
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'memory', 'knowledge-base'],
        description:
          'KB ingest use case that writes kb_document nodes and kb_document -> related_documents relationships into HSG (MEM-NEXT STEP1)',
      },
    );
  }
}

/**
 * Регистрация HTTP Controllers.
 *
 * ВАЖНО:
 * - Controllers живут в application-слое и должны регистрироваться здесь.
 * - `createHttpApp()` ([`src/application/app.ts`](src/application/app.ts:66)) резолвит контроллеры по DI-токенам.
 */
export function registerControllers(container: DIContainer): void {
  if (!container.isRegistered('ChatController')) {
    container.register(
      'ChatController',
      (c) =>
        new ChatController(
          c.resolve<ChatService>('chatService'),
          c.resolve<AuthService>('authService'),
          c.resolve<import('../services/RateLimitService').RateLimitService>(
            'rateLimitService',
          ),
          c.resolve<SendMessageUseCase>(ApplicationServiceTokens.SEND_MESSAGE),
          c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['controller', 'http', 'chat'],
        description: 'Chat HTTP controller',
      },
    );
  }

  if (!container.isRegistered('ConversationController')) {
    container.register(
      'ConversationController',
      (c) =>
        new ConversationController(
          c.resolve<AuthService>('authService'),
          c.resolve<import('../services/RateLimitService').RateLimitService>(
            'rateLimitService',
          ),
          c.resolve<CreateConversationUseCase>(
            ApplicationServiceTokens.CREATE_CONVERSATION,
          ),
          c.resolve<GetConversationUseCase>(
            ApplicationServiceTokens.GET_CONVERSATION,
          ),
          c.resolve<UpdateConversationUseCase>(
            ApplicationServiceTokens.UPDATE_CONVERSATION,
          ),
          c.resolve<ArchiveConversationUseCase>(
            ApplicationServiceTokens.ARCHIVE_CONVERSATION,
          ),
          c.resolve<ListConversationsUseCase>(
            ApplicationServiceTokens.LIST_CONVERSATIONS,
          ),
          c.resolve<DeleteConversationUseCase>(
            ApplicationServiceTokens.DELETE_CONVERSATION,
          ),
          c.resolve<ExportConversationsUseCase>(
            ApplicationServiceTokens.EXPORT_CONVERSATIONS,
          ),
          c.resolve<ImportConversationsUseCase>(
            ApplicationServiceTokens.IMPORT_CONVERSATIONS,
          ),
          c.resolve<UploadFileUseCase>(
            ApplicationServiceTokens.UPLOAD_FILE,
          ),
          c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['controller', 'http', 'conversation'],
        description: 'Conversation HTTP controller',
      },
    );
  }

  if (!container.isRegistered('PluginController')) {
    container.register(
      'PluginController',
      (c) =>
        new PluginController(
          c.resolve<IUnifiedPluginRegistry>(
            PluginRuntimeServiceTokens.UNIFIED_PLUGIN_REGISTRY,
          ),
          c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['controller', 'http', 'plugins'],
        description: 'Unified Plugin Registry HTTP controller',
      },
    );
  }

  if (!container.isRegistered('SlackEntController')) {
    container.register(
      'SlackEntController',
      (c) =>
        new SlackEntController(
          c.resolve<SlackSlashCommandUseCase>('SlackSlashCommandUseCase'),
          c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['controller', 'http', 'slack'],
        description: 'Enterprise Slack HTTP controller',
      },
    );
  }

  if (!container.isRegistered('MemorySearchController')) {
    container.register(
      'MemorySearchController',
      (c) =>
        new MemorySearchController(
          c.resolve<AuthService>('authService'),
          c.resolve<SemanticSearchUseCase>(
            ApplicationServiceTokens.SEMANTIC_SEARCH,
          ),
          c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['controller', 'http', 'memory'],
        description: 'Memory semantic-search HTTP controller',
      },
    );
  }

  if (!container.isRegistered('MasController')) {
    container.register(
      'MasController',
      (c) =>
        new MasController(
          c.resolve<AuthService>('authService'),
          c.resolve<import('../services/RateLimitService').RateLimitService>(
            'rateLimitService',
          ),
          c.resolve<MasGeneratePlanUseCase>(
            ApplicationServiceTokens.MAS_GENERATE_PLAN,
          ),
          c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['controller', 'http', 'mas'],
        description: 'MAS BFF controller',
      },
    );
  }

  if (!container.isRegistered('McpApprovalsController')) {
    container.register(
      'McpApprovalsController',
      (c) =>
        new McpApprovalsController(
          c.resolve(DI_TOKENS.IUserApprovalInterceptor),
          c.isRegistered('ILogger') ? c.resolve<ILogger>('ILogger') : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['controller', 'http', 'mcp', 'approval'],
        description: 'MCP approvals HTTP controller',
      },
    );
  }

}

/**
 * Главная точка входа для Application Layer DI
 *
 * Вызывается после регистрации Infrastructure dependencies (repo, outbox).
 */
export function bootstrapApplicationLayer(container: DIContainer): void {
  // 1) Доменные сервисы (не зависят от инфраструктуры)
  registerDomainServices(container);
  // 2) Use Cases (требуют repo/outbox из Infrastructure — должны быть зарегистрированы заранее)
  registerConversationUseCases(container);
  // 3) MAS Runtime Core services (Registered in mas-core.module.ts)
  // registerMasRuntimeServices(container); // REMOVED: Duplicate logic, see mas-core.module.ts
  // 4) MAS Application Use Cases (поверх MasterAgent)
  registerMasUseCases(container);
  // 5) Memory / Multimodal Use Cases
  registerMemoryUseCases(container);
  // 6) Plugin Runtime Services
  registerPluginRuntimeServices(container);
  // 7) Identity Use Cases
  registerIdentityUseCases(container);
  // 8) Research / Education Use Cases (optional: MODULE_RESEARCH_ENABLED)
  if (isModuleEnabled('MODULE_RESEARCH_ENABLED')) {
    registerResearchUseCasesFromDI(container);
  }
  // 9) Sales Use Cases
  registerSalesUseCases(container);
  // 10) HR Use Cases
  registerHrUseCases(container);
  // 11) Healthcare Use Cases (optional: MODULE_HEALTHCARE_ENABLED)
  if (isModuleEnabled('MODULE_HEALTHCARE_ENABLED')) {
    registerHealthcareUseCases(container);
  }
  // 12) Controllers
  registerControllers(container);
}

/**
 * Регистрация MAS Runtime Core сервисов в Application-слое.
 *
 * ВАЖНО:
 * - Реализации живут в Application/MAS слоях и используют только Domain/Memory контракты.
 * - DI SSOT остаётся в [`src/infrastructure/di/bootstrap.ts`](src/infrastructure/di/bootstrap.ts:1),
 *   который вызывает bootstrapApplicationLayer(container).
 */
// registerMasRuntimeServices removed to enforce SSOT in mas-core.module.ts

export function registerMasUseCases(container: DIContainer): void {
  if (!container.isRegistered(ApplicationServiceTokens.MAS_GENERATE_PLAN)) {
    container.register<MasGeneratePlanUseCase>(
      ApplicationServiceTokens.MAS_GENERATE_PLAN,
      (c) => {
        const masterAgent = c.resolve<IMasterAgent>(masterAgentToken);
        return new MasGeneratePlanUseCase(masterAgent);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'mas', 'planning'],
        description:
          'Application-level MAS generate-plan use case over IMasterAgent (MAS-NEXT-STEP5)',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.MAS_ADVANCED_RETRIEVAL)) {
    container.register(
      ApplicationServiceTokens.MAS_ADVANCED_RETRIEVAL,
      (c) => {
         const useCase = c.resolve<AdvancedRetrievalUseCase>(ApplicationServiceTokens.ADVANCED_RETRIEVAL);
        return new MasAdvancedRetrievalFacade(useCase);
      },
      {
        lifecycle: 'singleton',
        tags: ['mas', 'memory', 'facade'],
        description: 'Facade for MAS Advanced Retrieval (RAG/Knowledge)',
      }
    );
  }
}

/**
 * Identity Use Cases Registration.
 *
 * Registers RegisterUserUseCase and ProvisionTenantUseCase.
 * Resolves controllers in infrastructure/di/bootstrap.ts via DI tokens.
 */
export function registerIdentityUseCases(container: DIContainer): void {
  if (!container.isRegistered('RegisterUserUseCase')) {
    container.register(
      'RegisterUserUseCase',
      (c) => {
        const { RegisterUserUseCase } = require('../identity/usecases/RegisterUserUseCase') as typeof import('../identity/usecases/RegisterUserUseCase');
        const userRepository = c.resolve<IUserRepository>(DI_TOKENS.IUserRepository);
        const tenantRepository = c.resolve<ITenantRepository>(DI_TOKENS.ITenantRepository);
        return new RegisterUserUseCase(userRepository, tenantRepository);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'identity'],
        description: 'Register a new user within a tenant',
      },
    );
  }

  if (!container.isRegistered('ProvisionTenantUseCase')) {
    container.register(
      'ProvisionTenantUseCase',
      (c) => {
        const { ProvisionTenantUseCase } = require('../identity/usecases/ProvisionTenantUseCase') as typeof import('../identity/usecases/ProvisionTenantUseCase');
        const tenantRepository = c.resolve<ITenantRepository>(DI_TOKENS.ITenantRepository);
        const userRepository = c.resolve<IUserRepository>(DI_TOKENS.IUserRepository);
        return new ProvisionTenantUseCase(tenantRepository, userRepository);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'identity'],
        description: 'Provision a new tenant with admin user',
      },
    );
  }
}

/**
 * Sales Use Cases Registration.
 */
export function registerSalesUseCases(container: DIContainer): void {
  if (!container.isRegistered(ApplicationServiceTokens.LEAD_SCORING)) {
    container.register(
      ApplicationServiceTokens.LEAD_SCORING,
      (c) => {
        const { LeadScoringUseCase } = require('../usecases/sales') as typeof import('../usecases/sales');
        const eventStore = c.resolve<EventStoreService>('eventStoreService');
        const eventBus = c.resolve<EventBusService>('eventBusService');
        return new LeadScoringUseCase(eventStore, eventBus);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'sales'],
        description: 'Deterministic lead scoring use case',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.SALES_FORECASTING)) {
    container.register(
      ApplicationServiceTokens.SALES_FORECASTING,
      (c) => {
        const { SalesForecastingUseCase } = require('../usecases/sales') as typeof import('../usecases/sales');
        const eventStore = c.resolve<EventStoreService>('eventStoreService');
        const eventBus = c.resolve<EventBusService>('eventBusService');
        return new SalesForecastingUseCase(eventStore, eventBus);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'sales'],
        description: 'Weighted MA sales forecasting use case',
      },
    );
  }
}

/**
 * HR Use Cases Registration.
 */
export function registerHrUseCases(container: DIContainer): void {
  if (!container.isRegistered(ApplicationServiceTokens.TALENT_ACQUISITION)) {
    container.register(
      ApplicationServiceTokens.TALENT_ACQUISITION,
      (c) => {
        const { TalentAcquisitionUseCase } = require('../usecases/hr') as typeof import('../usecases/hr');
        const eventStore = c.resolve<EventStoreService>('eventStoreService');
        const eventBus = c.resolve<EventBusService>('eventBusService');
        return new TalentAcquisitionUseCase(eventStore, eventBus);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'hr'],
        description: 'Deterministic candidate-job matching use case',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.EMPLOYEE_ENGAGEMENT)) {
    container.register(
      ApplicationServiceTokens.EMPLOYEE_ENGAGEMENT,
      (c) => {
        const { EmployeeEngagementUseCase } = require('../usecases/hr') as typeof import('../usecases/hr');
        const eventStore = c.resolve<EventStoreService>('eventStoreService');
        const eventBus = c.resolve<EventBusService>('eventBusService');
        return new EmployeeEngagementUseCase(eventStore, eventBus);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'hr'],
        description: 'Engagement scoring from survey + performance data',
      },
    );
  }
}

/**
 * Healthcare Use Cases Registration.
 */
export function registerHealthcareUseCases(container: DIContainer): void {
  if (!container.isRegistered(ApplicationServiceTokens.DIAGNOSIS_SUPPORT)) {
    container.register(
      ApplicationServiceTokens.DIAGNOSIS_SUPPORT,
      (c) => {
        const { DiagnosisSupportUseCase } = require('../usecases/healthcare/DiagnosisSupportUseCase') as typeof import('../usecases/healthcare/DiagnosisSupportUseCase');
        const eventStore = c.resolve<import('../../domain/events/event-store.interface').IEventStore>('IEventStore');
        const sessionManager = c.resolve<ISessionMemoryManager>('ISessionMemoryManager');
        const pluginRegistry = c.resolve<IUnifiedPluginRegistry>('IUnifiedPluginRegistry');
        return new DiagnosisSupportUseCase(eventStore, sessionManager, pluginRegistry);
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'healthcare'],
        description: 'PatientCase aggregate diagnosis support with plugin enrichment',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.GENERATE_MRI_SECOND_OPINION)) {
    container.register(
      ApplicationServiceTokens.GENERATE_MRI_SECOND_OPINION,
      (c) => {
        const { GenerateMriSecondOpinionUseCase } = require('../services/GenerateMriSecondOpinionUseCase') as typeof import('../services/GenerateMriSecondOpinionUseCase');
        return new GenerateMriSecondOpinionUseCase(
          c.resolve(DI_TOKENS.IMriSecondOpinionCaseRepository),
          c.resolve(DI_TOKENS.ISecondOpinionInferenceService),
          c.resolve(DI_TOKENS.IClinicalSafetyPolicy),
        );
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'healthcare', 'mri', 'second-opinion'],
        description: 'MRI second-opinion orchestration use case with safety gating',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.COMPLETE_MRI_HUMAN_REVIEW)) {
    container.register(
      ApplicationServiceTokens.COMPLETE_MRI_HUMAN_REVIEW,
      (c) => {
        const { CompleteMriHumanReviewUseCase } = require('../services/CompleteMriHumanReviewUseCase') as typeof import('../services/CompleteMriHumanReviewUseCase');
        return new CompleteMriHumanReviewUseCase(
          c.resolve(DI_TOKENS.IMriSecondOpinionCaseRepository),
        );
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'healthcare', 'mri', 'review'],
        description: 'MRI second-opinion human review completion use case',
      },
    );
  }

  if (!container.isRegistered(ApplicationServiceTokens.FINALIZE_MRI_SECOND_OPINION)) {
    container.register(
      ApplicationServiceTokens.FINALIZE_MRI_SECOND_OPINION,
      (c) => {
        const { FinalizeMriSecondOpinionUseCase } = require('../services/FinalizeMriSecondOpinionUseCase') as typeof import('../services/FinalizeMriSecondOpinionUseCase');
        return new FinalizeMriSecondOpinionUseCase(
          c.resolve(DI_TOKENS.IMriSecondOpinionCaseRepository),
          c.isRegistered(DI_TOKENS.IMriDeliveryJobQueue)
            ? c.resolve(DI_TOKENS.IMriDeliveryJobQueue)
            : undefined,
        );
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'healthcare', 'mri', 'finalize'],
        description: 'MRI second-opinion finalization use case',
      },
    );
  }
}

/**
 * Research / Education Use Cases Registration.
 *
 * Delegates to research.di.ts which was previously defined but never wired.
 */
function registerResearchUseCasesFromDI(container: DIContainer): void {
  try {
    const { registerResearchUseCases } = require('./research.di') as typeof import('./research.di');
    registerResearchUseCases(container);
  } catch {
    // Research dependencies may not be registered yet (e.g. IResearchReportRepository)
    // Skip silently — research module is optional.
  }
}
 
/**
 * Хелперы для разрешения Use Cases
 * Используются в Controllers для получения экземпляров через DI
 */
export function resolveCreateConversationUseCase(container: DIContainer): CreateConversationUseCase {
  return container.resolve<CreateConversationUseCase>(ApplicationServiceTokens.CREATE_CONVERSATION);
}
export function resolveGetConversationUseCase(container: DIContainer): GetConversationUseCase {
  return container.resolve<GetConversationUseCase>(ApplicationServiceTokens.GET_CONVERSATION);
}
export function resolveAddParticipantUseCase(container: DIContainer): AddParticipantUseCase {
  return container.resolve<AddParticipantUseCase>(ApplicationServiceTokens.ADD_PARTICIPANT);
}
export function resolveArchiveConversationUseCase(container: DIContainer): ArchiveConversationUseCase {
  return container.resolve<ArchiveConversationUseCase>(ApplicationServiceTokens.ARCHIVE_CONVERSATION);
}
export function resolveSendMessageUseCase(container: DIContainer): SendMessageUseCase {
  return container.resolve<SendMessageUseCase>(ApplicationServiceTokens.SEND_MESSAGE);
}
export function resolveUpdateConversationUseCase(container: DIContainer): UpdateConversationUseCase {
  return container.resolve<UpdateConversationUseCase>(ApplicationServiceTokens.UPDATE_CONVERSATION);
}
export function resolveListConversationsUseCase(container: DIContainer): ListConversationsUseCase {
  return container.resolve<ListConversationsUseCase>(ApplicationServiceTokens.LIST_CONVERSATIONS);
}
export function resolveDeleteConversationUseCase(container: DIContainer): DeleteConversationUseCase {
  return container.resolve<DeleteConversationUseCase>(ApplicationServiceTokens.DELETE_CONVERSATION);
}
export function resolveExportConversationsUseCase(container: DIContainer): ExportConversationsUseCase {
  return container.resolve<ExportConversationsUseCase>(ApplicationServiceTokens.EXPORT_CONVERSATIONS);
}
export function resolveImportConversationsUseCase(container: DIContainer): ImportConversationsUseCase {
  return container.resolve<ImportConversationsUseCase>(ApplicationServiceTokens.IMPORT_CONVERSATIONS);
}
export function resolveUploadFileUseCase(container: DIContainer): UploadFileUseCase {
  return container.resolve<UploadFileUseCase>(ApplicationServiceTokens.UPLOAD_FILE);
}

export function resolveMultimodalIngestUseCase(container: DIContainer): MultimodalIngestUseCase {
  return container.resolve<MultimodalIngestUseCase>(ApplicationServiceTokens.MULTIMODAL_INGEST);
}
