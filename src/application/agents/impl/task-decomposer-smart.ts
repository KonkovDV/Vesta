/**
 * MAS Runtime Core - Smart Task Decomposer.
 *
 * Layer: Application (agents/impl).
 *
 * Responsibility:
 * - Decompose high-level MasRequest into a structured MasTaskPlan using LLM.
 * - Handles prompt construction, LLM invocation, and JSON validation.
 */

import type { ITaskDecomposer } from '../core/task-decomposer';
import { IdGenerator } from '../../../core/utils/IdGenerator';
import type {
  MasMetadataBag,
  MasRequest,
  MasSessionContext,
  MasTask,
  MasTaskId,
  MasTaskPlan,
  TaskDecompositionInput,
} from '../types/mas-types';
import type { LLMBackedChatService } from '../../services/LLMBackedChatService';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { IToolRegistry } from '../../../domain/agents/tools.interface';
import { inject } from 'inversify';

interface PlannedTaskDraft extends MasMetadataBag {
  id?: string;
  type?: string;
}

interface RawTaskPlan {
  tasks: PlannedTaskDraft[];
  entryTaskIds?: string[];
}

function isRawTaskPlan(value: unknown): value is RawTaskPlan {
  return typeof value === 'object' && value !== null && Array.isArray((value as { tasks?: unknown }).tasks);
}


export class TaskDecomposerSmart implements ITaskDecomposer {
  constructor(
    private readonly chatService: LLMBackedChatService,
    @inject('IToolRegistry') private readonly toolRegistry: IToolRegistry,
    private readonly logger?: ILogger
  ) {}

  async decomposeTask(input: TaskDecompositionInput): Promise<MasTaskPlan> {
    const { request, session } = input;
    
    this.logger?.debug('[TaskDecomposerSmart] Decomposing request', { scenario: request.scenario });

    // 1. Build System Prompt
    const prompt = this.buildDecompositionPrompt(request, session);

    // 2. Call LLM
    try {
      const completion = await this.chatService.generateChatCompletion(
        {
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: JSON.stringify(request.payload, null, 2) }
          ],
          model: 'gpt-4o',
          temperature: 0.2,
          // response_format not natively supported in DomainChatCompletionRequest types?
          // We'll rely on text prompt instruction or adapter support.
        },
        session.masSessionId,
        session.userId ?? 'system'
      );

      // 3. Parse Response
      const content = completion.content;

      if (typeof content !== 'string') {
         throw new Error('Invalid LLM response content');
      }

      const rawPlan = JSON.parse(content) as unknown;
      
      // 4. Validate/Sanitize Plan (Basic check)
      if (!isRawTaskPlan(rawPlan) || rawPlan.tasks.length === 0) {
        throw new Error('LLM returned empty or invalid task list');
      }

      const plan: MasTaskPlan = {
        tasks: rawPlan.tasks.map((t) => ({
            ...t,
            id: t.id || IdGenerator.generate(),
            status: 'pending',
            type: t.type || 'execution'
        })) as MasTask[],
        entryTaskIds: (rawPlan.entryTaskIds || []) as MasTaskId[],
        metadata: {
            source: 'llm_smart_decomposer',
            traceId: session.masTraceId
        }
      };
      
      // Auto-set entry tasks if missing
      if (plan.entryTaskIds.length === 0 && plan.tasks.length > 0) {
        // Find tasks with no dependencies
        const allIds = new Set(plan.tasks.map(t => t.id));
        const depIds = new Set(plan.tasks.flatMap(t => t.dependsOn || []));
        plan.entryTaskIds = plan.tasks.filter(t => !depIds.has(t.id)).map(t => t.id);
        
        // If all have deps (circular?), pick first.
        if (plan.entryTaskIds.length === 0) {
            plan.entryTaskIds = [plan.tasks[0].id];
        }
      }

      return plan;

    } catch (error) {
      this.logger?.error('[TaskDecomposerSmart] Decomposition failed', { error });
      throw error;
    }
  }

  private buildDecompositionPrompt(request: MasRequest, session: MasSessionContext): string {
    const tools = this.toolRegistry.listTools();
    const capabilities = tools
      .map(tool => `- ${tool.name}: ${tool.description || 'No description provided.'}`)
      .join('\n') || '- general_assistant: Basic reasoning (No external tools loaded).';

    return `
You are an expert Autonomous Agent Architect.
Your goal is to decompose a user request into a structured execution plan (DAG of tasks).

Request Context:
Scenario: ${request.scenario}
Use Case: ${request.useCase || 'N/A'}

Available Agent Capabilities (Tools):
${capabilities}

Output JSON Format:
{
  "tasks": [
    {
      "id": "task_1",
      "description": "...",
      "type": "planning" | "execution" | "research" | "review",
      "dependsOn": [], // List of task IDs that must complete first
      "requiredCapabilities": [{ "tag": "tool_name_here" }]
    }
  ],
  "entryTaskIds": ["task_1"]
}

Rules:
1. Break down complex requests into atomic steps.
2. Ensure dependencies are logical.
3. Use specific capability tags (tool names) from the list above.
`;
  }
}
