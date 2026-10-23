/**
 * Standard Inbound Context Processor
 * Layer: Infrastructure
 * 
 * The default implementation of the "Sense" mechanism.
 * converts InboundMessages into AgentTasks.
 * 
 * CRITICAL: Implements Loop Prevention.
 */

import { IInboundContextProcessor, InboundMessage } from '../../domain/interaction/InboundContextProcessor';
import { AgentTask, TaskPriority, TaskId, AgentId } from '../../domain/agent-runner/agent-runner.port';
import { CorrelationId } from '../../domain/routing/IRoutingContext';
import { SystemPromptBuilder } from './prompts/SystemPromptBuilder';
import { randomUUID } from 'crypto';

export class StandardInboundContextProcessor implements IInboundContextProcessor {
  /**
   * @param agentId The ID of the agent this processor serves. Used for Loop Prevention.
   */
  constructor(private readonly agentId: string) {}

  async process(input: InboundMessage): Promise<AgentTask | null> {
    // 1. Loop Prevention: The Filter
    // If the message is from the agent itself, IGNORE IT.
    if (input.senderId === this.agentId) {
      // Log? console.debug("Ignoring own message");
      return null;
    }

    // 2. Task Construction
    // We create a "Cognitive Script" for the worker to execute.
    // Ideally, this script is dynamic or loads a "Skill".
    // For Phase 2 Atomic Goal, we inline the "Reflexive Chat" logic.
    
    // The script must:
    // a) Construct the prompt (Context Assembly)
    // b) Call LLM (Thinking)
    // c) Output result (Acting)

    // Note: We are passing the current input. 
    // In a real system, the script implies fetching history.
    // Here, we'll keep it simple: "Reply to this specific message".

    // 2. Task Construction (via Builder)
    const systemPrompt = SystemPromptBuilder.from({ 
      agentId: this.agentId, 
      input: input,
      toolsAvailable: ['llm_completion', 'send_message'] 
    })
    .withIdentity()
    .withTooling()
    .withReflexiveLogic()
    .build();

    const agentScript = `
      // Generated Cognitive Script
      const prompt = ${JSON.stringify(systemPrompt)};
      // We also provide the raw conversation ID for tools to use
      const conversationId = ${JSON.stringify(input.conversationId)};
      
      // 1. Call LLM with the System Prompt
      // The logic here is: Use the System Prompt to guide the LLM's "Thought"
      const messages = [{ role: 'system', content: prompt }];
      
      const llmResult = await useTool('llm_completion', {
        messages: messages,
        temperature: 0,
        maxTokens: 1000
      });

      // 2. Parse result
      let replyContent = '';
      if (llmResult.content && llmResult.content.length > 0) {
         replyContent = llmResult.content[0].text;
      } else {
         replyContent = "I am unable to think right now.";
      }

      // 3. Send Message
      await useTool('send_message', {
        content: replyContent,
        metadata: {
           isThinkingResult: true
        }
      });

      return { success: true, replied: true };
    `;

    // 3. Create Task Object
    const task: AgentTask = {
      id: TaskId.create(),
      agentId: AgentId.create(this.agentId),
      type: 'javascript', // Worker supports this
      payload: {
        type: 'javascript',
        code: agentScript
      },
      priority: 'NORMAL',
      correlationId: input.metadata?.correlationId && CorrelationId.isValid(input.metadata.correlationId) 
        ? CorrelationId.parse(input.metadata.correlationId as string) 
        : CorrelationId.create(),
      timeoutMs: 60000,
      maxAttempts: 1,
      createdAt: new Date()
    };

    return task;
  }
}
