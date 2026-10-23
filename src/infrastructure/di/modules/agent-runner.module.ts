/**
 * Agent Runner DI Module
 * Registers AgentRunner services with the DI container.
 * Layer: Infrastructure/DI
 */

import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { IAgentRunner } from '../../../domain/agent-runner/agent-runner.port';
import { ITaskScheduler } from '../../../domain/agent-runner/task-scheduler.port';
import { ISandboxedExecutor } from '../../../domain/sandbox/sandboxed-executor.port';
import { AgentRunnerService } from '../../agent-runner/agent-runner.service';
import {
  InMemoryTaskScheduler,
  DEFAULT_SCHEDULER_CONFIG,
} from '../../agent-runner/inmemory-task-scheduler';
import { getConfig } from '../../../config';
import { IToolRegistry } from '../../../domain/agents/tools.interface';
import { ToolRegistry } from '../../../application/agents/services/ToolRegistry';
import { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';
import type { IIntentMisalignmentDetector } from '../../../domain/security/IIntentMisalignmentDetector';
import type { IAgentEventStream } from '../../../domain/agents/IAgentEventStream';
import type { IExecutionProvenanceTracer } from '../../../domain/agents/IExecutionProvenanceTracer';
import type { IS2iLessonExtractor } from '../../../domain/agents/IS2iLessonExtractor';
import type { ISuccessLedgerStore } from '../../../domain/memory/ISuccessLedgerStore';

/**
 * Agent runner module configuration
 */
export interface AgentRunnerModuleConfig {
  agentId: string;
  maxConcurrentTasks: number;
  maxQueueSize: number;
  enableWorkerThreads: boolean;
  gracefulShutdownTimeoutMs: number;
}

let schedulerInstance: InMemoryTaskScheduler | null = null;
let agentRunnerInstance: AgentRunnerService | null = null;

/**
 * Register AgentRunner services with DI container
 */
export function registerAgentRunnerServices(): void {
  try {
    const cfg = getConfig() as Record<string, string | undefined>;
    const agentId = cfg.AGENT_ID || 'default-agent';
    const maxConcurrentTasks = parseInt(String(cfg.AGENT_MAX_CONCURRENT || '10'), 10);
    const maxQueueSize = parseInt(String(cfg.AGENT_MAX_QUEUE || '1000'), 10);
    const enableWorkerThreads = cfg.AGENT_ENABLE_WORKERS !== 'false';
    const gracefulShutdownTimeoutMs = parseInt(String(cfg.AGENT_SHUTDOWN_TIMEOUT || '30000'), 10);

    console.log(`🤖 Registering AgentRunner services (agentId=${agentId})...`);

    // Register task scheduler
    container.register<ITaskScheduler>(
      'ITaskScheduler',
      () => {
        if (!schedulerInstance) {
          schedulerInstance = new InMemoryTaskScheduler({
            ...DEFAULT_SCHEDULER_CONFIG,
            maxQueueSize,
            maxConcurrentTasks,
          });
        }
        return schedulerInstance;
      },
      {
        lifecycle: 'singleton',
        tags: ['agent-runner', 'scheduler', 'task-queue'],
        description: 'In-memory task scheduler with priority-based scheduling',
      },
    );

    // Register agent runner
    container.register<IAgentRunner>(
      'IAgentRunner',
      (c) => {
        if (!agentRunnerInstance) {
          const scheduler = c.resolve<ITaskScheduler>('ITaskScheduler');
          const toolRegistry = c.resolve<IToolRegistry>(DI_TOKENS.IToolRegistry);
          const toolPolicy = c.resolve<IToolExecutionPolicy>(DI_TOKENS.IToolExecutionPolicy);
          const intentMisalignmentDetector = c.isRegistered(DI_TOKENS.IIntentMisalignmentDetector)
            ? c.resolve<IIntentMisalignmentDetector>(DI_TOKENS.IIntentMisalignmentDetector)
            : undefined;
          const agentEventStream = c.isRegistered(DI_TOKENS.IAgentEventStream)
            ? c.resolve<IAgentEventStream>(DI_TOKENS.IAgentEventStream)
            : undefined;
          const executionProvenanceTracer = c.isRegistered(DI_TOKENS.IExecutionProvenanceTracer)
            ? c.resolve<IExecutionProvenanceTracer>(DI_TOKENS.IExecutionProvenanceTracer)
            : undefined;
          const s2iLessonExtractor = c.isRegistered(DI_TOKENS.IS2iLessonExtractor)
            ? c.resolve<IS2iLessonExtractor>(DI_TOKENS.IS2iLessonExtractor)
            : undefined;
          const successLedgerStore = c.isRegistered(DI_TOKENS.ISuccessLedgerStore)
            ? c.resolve<ISuccessLedgerStore>(DI_TOKENS.ISuccessLedgerStore)
            : undefined;
          
          let sandboxExecutor: ISandboxedExecutor | undefined;
          
          try {
            sandboxExecutor = c.resolve<ISandboxedExecutor>(DI_TOKENS.ISandboxExecutor);
          } catch {
            // Sandbox executor is optional
            console.log('[AgentRunner] No sandbox executor available');
          }

          // Use DI pattern: instantiate directly in factory
          agentRunnerInstance = new AgentRunnerService({
            agentId,
            scheduler,
            sandboxExecutor,
            maxConcurrentTasks,
            enableWorkerThreads,
            gracefulShutdownTimeoutMs,
            toolRegistry,
            toolPolicy,
            intentMisalignmentDetector,
            agentEventStream,
            executionProvenanceTracer,
            successLedgerStore,
            s2iLessonExtractor,
          });
        }
        return agentRunnerInstance;
      },
      {
        lifecycle: 'singleton',
        tags: ['agent-runner', 'core'],
        description: 'Agent runner service with worker thread support',
      },
    );

    // Register module configuration
    container.register<AgentRunnerModuleConfig>(
      'AgentRunnerModuleConfig',
      () => ({
        agentId,
        maxConcurrentTasks,
        maxQueueSize,
        enableWorkerThreads,
        gracefulShutdownTimeoutMs,
      }),
      {
        lifecycle: 'singleton',
        tags: ['agent-runner', 'config'],
        description: 'Agent runner module configuration',
      },
    );

    console.log('✓ AgentRunner services registered');
  } catch (error) {
    console.error('✗ Failed to register AgentRunner services:', error);
    throw error;
  }
}

/**
 * Initialize agent runner services
 */
export async function initializeAgentRunnerServices(): Promise<void> {
  try {
    if (agentRunnerInstance) {
      await agentRunnerInstance.start();
      console.log('✓ AgentRunner started');
    }
  } catch (error) {
    console.error('✗ Failed to start AgentRunner:', error);
    throw error;
  }
}

/**
 * Shutdown agent runner services
 */
export async function shutdownAgentRunnerServices(): Promise<void> {
  try {
    if (agentRunnerInstance) {
      await agentRunnerInstance.stop();
      agentRunnerInstance = null;
      console.log('✓ AgentRunner stopped');
    }
    
    if (schedulerInstance) {
      await schedulerInstance.shutdown();
      schedulerInstance = null;
      console.log('✓ Task scheduler shut down');
    }
  } catch (error) {
    console.error('✗ Failed to shutdown AgentRunner:', error);
    throw error;
  }
}

/**
 * Get the configured agent runner instance
 */
export function getAgentRunnerInstance(): AgentRunnerService | null {
  return agentRunnerInstance;
}

/**
 * Get the configured task scheduler instance
 */
export function getTaskSchedulerInstance(): InMemoryTaskScheduler | null {
  return schedulerInstance;
}
