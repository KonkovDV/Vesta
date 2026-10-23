/**
 * MAS Core DI module.
 * Registers MAS core services (AgentRegistry, TaskDecomposer, ContextCoordinator, ExecutionStrategy, MasterAgent).
 * Layer: Infrastructure/DI.
 */
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { MasDurableExecutionService } from '../../../domain/mas/services/MasDurableExecutionService';
import {
  masterAgentToken,
  type IMasterAgent,
} from '../../../application/agents/core/master-agent';
import {
  contextCoordinatorToken,
  type IContextCoordinator,
} from '../../../application/agents/core/context-coordinator';
import {
  taskDecomposerToken,
  type ITaskDecomposer,
} from '../../../application/agents/core/task-decomposer';
import {
  agentRegistryToken,
  type IAgentRegistry,
} from '../../../application/agents/core/agent-registry';
import {
  executionStrategyToken,
  type IExecutionStrategy,
} from '../../../application/agents/core/execution-strategy';
import {
masRuntimePolicyServiceToken,
type IMasRuntimePolicyService,
createMasRuntimePolicyService,
} from '../../../application/agents/core/mas-runtime-policy.service';
import { MasterAgentV1 } from '../../../application/agents/impl/master-agent-v1';
import { ContextCoordinatorV1 } from '../../../application/agents/impl/context-coordinator-v1';
import { TaskDecomposerV1 } from '../../../application/agents/impl/task-decomposer-v1';
import { AgentRegistryStaticV1 } from '../../../application/agents/impl/agent-registry-static-v1';
import { SequentialExecutionStrategy } from '../../../application/agents/impl/execution-strategy-sequential';
import { ParallelExecutionStrategy } from '../../../application/agents/impl/execution-strategy-parallel';
import { AgentRouter, agentRouterToken } from '../../../application/routing/AgentRouter';
import { TaskOrchestrator, taskOrchestratorToken } from '../../../application/orchestration/TaskOrchestrator';
import { MasExecutionLoop } from '../../../application/agents/services/MasExecutionLoop';
import type { ExecutionStrategyType } from '../../../application/agents/types/mas-types';
import { getConfig, getRawEnv } from '../../../config';
import type { ISessionMemoryManager } from '../../../domain/memory/ISessionMemoryManager';
import type {
  IMasSessionStore,
  MasSessionState,
} from '../../../domain/mas/mas-session-store';
import type { MasSessionId } from '../../../domain/mas/mas-types';
import type { ICache } from '../../../domain/cache/ICache';
import { RedisMasSessionStore } from '../../mas/RedisMasSessionStore';
import { DualWriteMasSessionStore } from '../../mas/session/DualWriteMasSessionStore';
import type { FeatureFlagsService } from '../../../application/services/FeatureFlagsService';

type ConfigLoaderLike = {
  get(): Record<string, unknown>;
  getValue?(key: string): unknown;
};

export function registerMasCoreServices(): void {
  try {
    class InMemoryMasSessionStore implements IMasSessionStore {
      private readonly sessions = new Map<string, { state: MasSessionState; lastAccessed: number }>();
      private readonly SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
      private readonly MAX_SESSIONS = 10000;

      private cleanup(): void {
        const now = Date.now();
        for (const [id, entry] of this.sessions) {
          if (now - entry.lastAccessed > this.SESSION_TTL_MS) {
            this.sessions.delete(id);
          }
        }
      }

      async getSession(
        sessionId: MasSessionId,
      ): Promise<MasSessionState | null> {
        const key = String(sessionId);
        const entry = this.sessions.get(key);
        if (!entry) {
          return null;
        }
        entry.lastAccessed = Date.now();
        return entry.state;
      }

      async saveSession(state: MasSessionState): Promise<void> {
        const key = String(state.sessionId);
        const nowIso = new Date().toISOString();
        const existingEntry = this.sessions.get(key);
        const existing = existingEntry?.state;

        const normalized: MasSessionState = {
          ...state,
          version:
            typeof state.version === 'number' && Number.isFinite(state.version)
              ? state.version
              : existing?.version ?? 0,
          createdAt: state.createdAt ?? existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
        };

        this.sessions.set(key, { state: normalized, lastAccessed: Date.now() });

        if (this.sessions.size > this.MAX_SESSIONS) {
          this.cleanup();
        }
      }

      async deleteSession(sessionId: MasSessionId): Promise<void> {
        const key = String(sessionId);
        this.sessions.delete(key);
      }

      async listRunnableSessions(limit: number = 50): Promise<MasSessionId[]> {
        const result: MasSessionId[] = [];
        for (const [key, entry] of this.sessions) {
          if (entry.state.status === 'active' || entry.state.status === 'pending' || entry.state.status === 'in_progress') {
             result.push(entry.state.sessionId);
             if (result.length >= limit) break;
          }
        }
        return result;
      }

      async resetStuckSessions(maxDurationMs: number): Promise<number> {
          const now = Date.now();
          let count = 0;
          for (const [key, entry] of this.sessions) {
              if (entry.state.status === 'in_progress') {
                   // In-Memory store doesn't track "last execution start" perfectly in state,
                   // but we use lastAccessed (updated on getSession) as a proxy.
                   const elapsed = now - entry.lastAccessed;
                   if (elapsed > maxDurationMs) {
                       entry.state.status = 'pending';
                       entry.state.updatedAt = new Date().toISOString();
                       count++;
                   }
              }
          }
          return count;
      }
    }

    container.register<IMasSessionStore>(
      DI_TOKENS.IMasSessionStore,
      (c) => {
        const primary = new InMemoryMasSessionStore();

        let redisStore: IMasSessionStore | undefined;

        try {
          const cache = c.resolve<ICache>(DI_TOKENS.ICache);
          redisStore = new RedisMasSessionStore(cache);
        } catch (error) {
           
          console.error(
            '[registerMasCoreServices] Failed to initialize RedisMasSessionStore, falling back to in-memory only',
            error,
          );
          redisStore = undefined;
        }

        if (!redisStore) {
          return primary;
        }

        const cfg = getConfig();
        const modeRaw = cfg.MAS_SESSION_STORE;
        const mode = modeRaw ? modeRaw.toLowerCase() : 'featureflag';

        // Legacy env override for non-R2.1 environments:
        // - MAS_SESSION_STORE=redis       -> force pure Redis backend (reads+writes in Redis);
        // - MAS_SESSION_STORE=inmemory    -> force in-memory only;
        // - other / undefined             -> use feature-flag-based dual-write (R2.1-C1).
        if (mode === 'redis') {
          return redisStore;
        }

        if (mode === 'inmemory') {
          return primary;
        }

        let dualWriteEnabled = false;
        let readFromRedisFirstEnabled = false;

        if (c.isRegistered('FeatureFlagsService')) {
          const featureFlags = c.resolve<FeatureFlagsService>('FeatureFlagsService');

          try {
            dualWriteEnabled = featureFlags.isEnabled('redisMasSessionDualWrite');
            readFromRedisFirstEnabled = featureFlags.isEnabled(
              'redisMasSessionReadFromRedisFirst',
            );
          } catch (error) {
             
            console.error(
              '[registerMasCoreServices] Failed to evaluate redisMasSessionDualWrite flag, falling back to primary-only MAS session store',
              error,
            );
            dualWriteEnabled = false;
            readFromRedisFirstEnabled = false;
          }
        }

        if (!dualWriteEnabled) {
          return primary;
        }

        const logger = c.isRegistered(DI_TOKENS.ILogger)
          ? c.resolve<ILogger>(DI_TOKENS.ILogger)
          : undefined;

        return new DualWriteMasSessionStore(
          primary,
          redisStore,
          logger ?? null,
          dualWriteEnabled && readFromRedisFirstEnabled,
        );
      },
      {
        lifecycle: 'singleton',
        tags: ['mas', 'session', 'state', 'store'],
        description:
          'MAS session store (in-memory primary with optional Redis dual-write; controlled by redisMasSessionDualWrite feature flag)',
      },
    );

    container.register<IMasRuntimePolicyService>(
      masRuntimePolicyServiceToken,
      (c) =>
        createMasRuntimePolicyService(
          undefined,
          {
            get: () => c.resolve<ConfigLoaderLike>(DI_TOKENS.IConfigLoader).get(),
            getValue: (key: string) => getRawEnv()[key],
          },
        ),
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'policy'],
        description:
          'MAS Runtime Policy Service (non-durable retry/session-breaker)',
      },
    );

    container.register<IAgentRegistry>(
      agentRegistryToken,
      () => new AgentRegistryStaticV1(),
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'registry'],
        description: 'MAS Agent Registry (Static V1)',
      },
    );

    container.register<ITaskDecomposer>(
      taskDecomposerToken,
      (c) => {
          // Use Smart Decomposer only when ChatService supports LLM completion API.
          if (c.isRegistered('ChatService')) {
            const chatService = c.resolve<import('../../../application/services/LLMBackedChatService').LLMBackedChatService>('ChatService');
            const canUseSmart = typeof (chatService as { generateChatCompletion?: unknown }).generateChatCompletion === 'function';
            if (!canUseSmart) {
              return new TaskDecomposerV1();
            }

              const toolRegistry = c.isRegistered(DI_TOKENS.IToolRegistry)
                ? c.resolve<import('../../../domain/agents/tools.interface').IToolRegistry>(DI_TOKENS.IToolRegistry)
              : { listTools: () => [] };
            const logger = c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : undefined;
            return new (require('../../../application/agents/impl/task-decomposer-smart').TaskDecomposerSmart)(chatService, toolRegistry, logger);
          }
          return new TaskDecomposerV1();
      },
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'decomposer'],
        description: 'MAS Task Decomposer (Smart if available, else V1)',
      },
    );

    container.register<IContextCoordinator>(
      contextCoordinatorToken,
      (c) => {
        const sessionMemoryManager = c.resolve<ISessionMemoryManager>(
          'ISessionMemoryManager',
        );
        const logger = c.isRegistered(DI_TOKENS.ILogger)
          ? c.resolve<ILogger>(DI_TOKENS.ILogger)
          : undefined;
        return new ContextCoordinatorV1(sessionMemoryManager, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'coordinator'],
        description: 'MAS Context Coordinator (V1)',
      },
    );

    container.register<IExecutionStrategy>(
      executionStrategyToken,
      () => new SequentialExecutionStrategy(),
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'execution', 'strategy'],
        description: 'Default MAS execution strategy (sequential, v1 skeleton)',
      },
    );

    container.register<AgentRouter>(
      agentRouterToken,
      (c) => new AgentRouter(
        c.resolve(agentRegistryToken),
        c.resolve(contextCoordinatorToken)
      ),
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'router'],
        description: 'MAS Agent Router',
      }
    );

    container.register<TaskOrchestrator>(
      taskOrchestratorToken,
      (c) => {
        const defaultStrategy = c.resolve<IExecutionStrategy>(executionStrategyToken);
        const parallelStrategy = new ParallelExecutionStrategy();
        const strategies = new Map<ExecutionStrategyType, IExecutionStrategy>();
        strategies.set('sequential', defaultStrategy);
        strategies.set('parallel', parallelStrategy);

        const durableExecutionService = c.isRegistered(DI_TOKENS.masDurableExecutionService)
          ? c.resolve<MasDurableExecutionService>('masDurableExecutionService')
          : undefined;

        const sessionStore = c.isRegistered(DI_TOKENS.IMasSessionStore)
          ? (c.resolve<IMasSessionStore>(DI_TOKENS.IMasSessionStore))
          : undefined;

        const eventStoreService = c.isRegistered('eventStoreService')
          ? c.resolve<import('../../../application/services/EventStoreService').EventStoreService>('eventStoreService')
          : undefined;

        return new TaskOrchestrator(
          c.resolve(taskDecomposerToken),
          c.resolve(agentRouterToken),
          sessionStore,
          strategies,
          defaultStrategy,
          c.resolve(masRuntimePolicyServiceToken),
          durableExecutionService,
          eventStoreService,
          c.isRegistered(DI_TOKENS.IAutonomousExecutionLoop)
            ? c.resolve(DI_TOKENS.IAutonomousExecutionLoop)
            : undefined,
        );
      },
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'orchestrator'],
        description: 'MAS Task Orchestrator',
      }
    );

    container.register<IMasterAgent>(
      masterAgentToken,
      (c) => {
        return new MasterAgentV1(
          c.resolve(taskOrchestratorToken)
        );
      },
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'master-agent'],
        description: 'MAS Master Agent (V1)',
      },
    );

    container.register<MasExecutionLoop>(
      'MasExecutionLoop',
      (c) => new MasExecutionLoop(
        c.resolve(DI_TOKENS.IMasSessionStore),
        c.resolve(taskOrchestratorToken),
        c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : undefined
      ),
      {
        lifecycle: 'singleton',
        tags: ['mas', 'core', 'execution-loop'],
        description: 'MAS Autonomous Execution Loop',
      }
    );

     
    console.log('✓ MAS Core services registered');
  } catch (error) {
     
    console.error('✗ Failed to register MAS Core services:', error);
    throw error;
  }
}
