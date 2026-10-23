/**
 * Interaction Module DI
 * Layer: Infrastructure
 * 
 * Registers:
 * 1. StandardInboundContextProcessor (Core Interaction)
 * 2. SendMessageTool & LlmCompletionTool (Tools)
 */

import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { StandardInboundContextProcessor } from '../../interaction/StandardInboundContextProcessor';
import { SendMessageTool } from '../../tools/SendMessageTool';
import { LlmCompletionTool } from '../../tools/LlmCompletionTool';
import { ApplicationServiceTokens } from '../../../application/di/bootstrap';
import { SendMessageUseCase } from '../../../application/usecases/conversations';
import { ChatService } from '../../../domain/services/ChatService';
import { ToolRegistry } from '../../../application/agents/services/ToolRegistry';
import { WorkspaceReadFileTool } from '../../../application/agents/tools/workspace-read-file.tool';
import { SearchTextTool } from '../../../application/agents/tools/search-text.tool';
import { FinishTool } from '../../../application/agents/tools/finish.tool';
import { registerBashToolIfAvailable } from '../../../application/agents/tools/BashTool';
import { registerPythonToolIfAvailable } from '../../../application/agents/tools/PythonTool';
import type { IProcessContainer } from '../../../domain/sandbox/IProcessContainer';
import { IToolRegistry } from '../../../domain/agents/tools.interface';
import type { IPromptInjectionScanner } from '../../../domain/security/prompt-injection-scanner.port';
import { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';
import { getConfig } from '../../../config';

const TOKENS = {
  IInboundContextProcessor: 'IInboundContextProcessor'
};

/**
 * Register Core Interaction components.
 * MUST be called BEFORE Application layer (because SendMessageUseCase depends on Processor).
 */
export function registerInteractionCore(): void {
  const cfg = getConfig();
  const agentId = (cfg.AGENT_ID as string) || 'default-agent';

  if (!container.isRegistered(TOKENS.IInboundContextProcessor)) {
    container.register(
      TOKENS.IInboundContextProcessor,
      () => new StandardInboundContextProcessor(agentId),
      {
        lifecycle: 'singleton',
        tags: ['interaction', 'core', 'processor'],
        description: 'Standard Inbound Context Processor with Loop Prevention'
      }
    );
  }

  // Register Tool Registry (Core Agent Component)
  if (!container.isRegistered(DI_TOKENS.IToolRegistry)) {
    container.register<IToolRegistry>(
      'IToolRegistry',
      (c) => {
         const logger = c.resolve<import('../../../core/decorators/ILogger').ILogger>(DI_TOKENS.ILogger);
         // IToolExecutionPolicy is registered in Application Layer (registerDomainServices).
         // Ensure this flows correct via lazy resolution or ensure App Layer registers it.
         // Note: registerInteractionCore runs BEFORE App Layer.
         // But resolution happens later (Lazy).
         const policy = c.resolve<IToolExecutionPolicy>(DI_TOKENS.IToolExecutionPolicy);
         return new ToolRegistry(logger, policy);
      },
      {
        lifecycle: 'singleton',
        tags: ['interaction', 'tools', 'registry'],
        description: 'Central Tool Registry for Agents'
      }
    );
  }
}

/**
 * Register Interaction Tools.
 * MUST be called AFTER Application layer (because Tools depend on UseCases).
 */
export async function registerInteractionTools(): Promise<void> {
  // 1. Send Message Tool
  // Note: We don't have a rigid generic way to register tools into the Registry yet via DI modules directly,
  // usually they are loaded by a Loader. But for core tools, we can register them as services
  // and manually add them to registry, OR just register them so they can be resolved if needed.
  // Ideally, the 'IToolRegistry' implementation should be able to pick these up, or we explicitly add them.
  // For Phase 2, we will register them as transient services. The Agent Runner/Worker might need a way to 'find' them.
  // *Correction*: The Worker runs in a separate thread. It uses 'useTool' which sends RPC to Main.
  // Main thread needs to handle 'CallTool' message.
  // The Main thread's ToolRegistry must have these tools.
  // So we need to: Resolve ToolRegistry and .registerTool(...) these instances.

  // We'll wrap this in an initialization function or do it here if Registry is available.
  // Registry is likely available if registerAgentRunnerServices was called.

  try {
     const registry = container.resolve<import('../../../domain/agents/tools.interface').IToolRegistry>(DI_TOKENS.IToolRegistry);

     // SendMessageTool
     const sendMessageUseCase = container.resolve<SendMessageUseCase>(ApplicationServiceTokens.SEND_MESSAGE);
     const logger = container.isRegistered(DI_TOKENS.ILogger) ? container.resolve<import('../../../core/decorators/ILogger').ILogger>(DI_TOKENS.ILogger) : undefined;
     const sendMessageTool = new SendMessageTool(sendMessageUseCase, logger);
     registry.register(sendMessageTool);

     // LlmCompletionTool
     const chatService = container.resolve<ChatService>('IChatService');
     const llmTool = new LlmCompletionTool(chatService);
     registry.register(llmTool);

     const scanner = container.isRegistered(DI_TOKENS.IPromptInjectionScanner)
       ? container.resolve<IPromptInjectionScanner>(DI_TOKENS.IPromptInjectionScanner)
       : undefined;
     registry.register(new WorkspaceReadFileTool(scanner));
     registry.register(new SearchTextTool(scanner));
     registry.register(new FinishTool());

     if (container.isRegistered(DI_TOKENS.IProcessContainer)) {
       const processContainer = container.resolve<IProcessContainer>(DI_TOKENS.IProcessContainer);
       await registerBashToolIfAvailable(registry, processContainer);
       await registerPythonToolIfAvailable(registry, processContainer);
     }

     console.log('✓ Interaction Tools registered with ToolRegistry');

  } catch (err) {
      console.warn('⚠ Could not register Interaction Tools to Registry automatically (Registry or deps missing):', err);
  }
}
