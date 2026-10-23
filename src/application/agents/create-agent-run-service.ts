/**
 * Builds the agent loop when its ports are registered.
 * Layer: Application
 */

import type { IChatCompletionModel } from '../../domain/ai/IChatCompletionModel';
import type { IToolRegistry } from '../../domain/agents/tools.interface';
import type { IEventStore } from '../../domain/events/event-store.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IToolExecutionPolicy } from '../../domain/security/tool-execution-policy.interface';
import type { IUserApprovalInterceptor } from '../../domain/security/IUserApprovalInterceptor';
import { DI_TOKENS } from '../../core/di/DI_TOKENS';
import { AgentRunService, agentRunControls } from './AgentRunService';

export interface AgentRunContainer {
  isRegistered(token: string): boolean;
  resolve<T>(token: string): T;
}

export function createAgentRunServiceFromTokens(resolver: AgentRunContainer): AgentRunService | undefined {
  const required = [
    DI_TOKENS.IChatCompletionModel,
    DI_TOKENS.IToolRegistry,
    DI_TOKENS.IToolExecutionPolicy,
    DI_TOKENS.IEventStore,
    DI_TOKENS.ILogger,
  ];
  if (required.some((token) => !resolver.isRegistered(token))) {
    return undefined;
  }
  const flags = resolver.isRegistered('FeatureFlagsService')
    ? resolver.resolve<{ isEnabled(flag: 'AGENTS_KILL_SWITCH'): boolean }>('FeatureFlagsService')
    : undefined;
  return new AgentRunService(
    resolver.resolve<IChatCompletionModel>(DI_TOKENS.IChatCompletionModel),
    resolver.resolve<IToolRegistry>(DI_TOKENS.IToolRegistry),
    resolver.resolve<IToolExecutionPolicy>(DI_TOKENS.IToolExecutionPolicy),
    resolver.resolve<IEventStore>(DI_TOKENS.IEventStore),
    resolver.resolve<ILogger>(DI_TOKENS.ILogger),
    resolver.isRegistered(DI_TOKENS.IUserApprovalInterceptor)
      ? resolver.resolve<IUserApprovalInterceptor>(DI_TOKENS.IUserApprovalInterceptor)
      : undefined,
    flags ? agentRunControls(flags) : undefined,
  );
}
