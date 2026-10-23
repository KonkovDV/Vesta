/**
 * MAS Runtime Core - Agent Router.
 *
 * Layer: Application (business orchestration).
 *
 * Responsibilities:
 * - Analyze task requirements.
 * - Consult AgentRegistry.
 * - Prepare context window (via ContextCoordinator) to verify readiness.
 * - Return optimal agent or failure.
 */
import type {
  IRequestContext,
} from '../context/request-context';
import type {
  MasSessionContext,
  MasTask,
  AgentDescriptor,
  AgentSelectionCriteria,
} from '../agents/types/mas-types';
import type { IAgentRegistry } from '../agents/core/agent-registry';
import { ensureMasTraceIdsInContext } from '../agents/context/mas-request-context';
import type { IContextCoordinator } from '../agents/core/context-coordinator';

export const agentRouterToken = 'AgentRouter';

export interface AgentSelectionResult {
  success: boolean;
  task: MasTask;
  agent?: AgentDescriptor;
  contextMetadata?: {
    messages: number;
    knowledgeSnippets: number;
  };
  failureReason?: string;
  error?: string;
}

/**
 * Application Service for selecting the best agent for a given task.
 *
 * Responsibilities:
 * - Analyze task requirements.
 * - Consult AgentRegistry.
 * - Prepare context window (via ContextCoordinator) to verify readiness.
 * - Return optimal agent or failure.
 */
export class AgentRouter {
  constructor(
    private readonly agentRegistry: IAgentRegistry,
    private readonly contextCoordinator: IContextCoordinator,
  ) {}

  async selectBestAgent(
    task: MasTask,
    session: MasSessionContext,
    request: { scenario: string; useCase?: string },
    requestContext: IRequestContext,
  ): Promise<AgentSelectionResult> {
    // Ensure MAS identifiers are propagated into RequestContext
    ensureMasTraceIdsInContext(session, requestContext);

    const scenario = request.scenario;
    const useCase = request.useCase;

    // 1. Fetch Context Window to understand data availability
    const contextWindow = await this.contextCoordinator.getContextWindow(
      {
        session,
        taskId: task.id,
        scenario,
        useCase,
        metadata: {
          scenario,
          use_case: useCase,
          task_id: String(task.id),
          task_type: task.type,
        },
      },
      requestContext,
    );

    // 2. Build Selection Criteria
    const requiredCapabilities = task.requiredCapabilities ?? [];
    const requiredCapabilityTags =
      requiredCapabilities.length > 0
        ? requiredCapabilities
            .map(cap => cap.tag)
            .filter(
              (tag): tag is string =>
                typeof tag === 'string' && tag.trim().length > 0,
            )
        : undefined;

    const hasPreferredRole = Boolean(task.preferredAgentRole);
    const hasUseCase = typeof useCase === 'string' && useCase.length > 0;

    const additionalFilters =
      hasPreferredRole || hasUseCase
        ? {
            ...(hasPreferredRole
              ? { preferredRole: task.preferredAgentRole }
              : {}),
            ...(hasUseCase ? { useCase } : {}),
          }
        : undefined;

    const criteria: AgentSelectionCriteria = {
      scenario,
      requiredCapabilities:
        requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
      requiredCapabilityTags,
      additionalFilters,
    };

    // 3. Find Agents
    const agents = await this.agentRegistry.findAgents(criteria);

    if (!agents || agents.length === 0) {
      const failedTask: MasTask = {
        ...task,
        status: 'failed',
        metadata: {
          ...(task.metadata ?? {}),
          masAgentSelection: {
            status: 'no_agents_available',
          },
        },
      };

      return {
        success: false,
        task: failedTask,
        failureReason: 'unknown',
        error: 'No MAS agents available for task based on required capabilities and scenario.',
      };
    }

    // 4. Select Primary Agent (Simple version: take the first one)
    const primaryAgent: AgentDescriptor = agents[0];

    // 5. Update Task Metadata
    const updatedTask: MasTask = {
      ...task,
      status: 'completed',
      metadata: {
        ...(task.metadata ?? {}),
        masAgent: {
          id: primaryAgent.id,
          name: primaryAgent.name,
        },
        masContextWindow: {
          messages: contextWindow.messages.length,
          knowledgeSnippets:
            contextWindow.knowledgeSnippets?.length ?? 0,
        },
      },
    };

    return {
      success: true,
      task: updatedTask,
      agent: primaryAgent,
      contextMetadata: {
        messages: contextWindow.messages.length,
        knowledgeSnippets: contextWindow.knowledgeSnippets?.length ?? 0,
      },
    };
  }
}
