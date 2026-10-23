/**
 * LLM Completion Tool
 * Layer: Infrastructure
 * 
 * Provides access to the LLM (Large Language Model) for the Agent.
 * This tool bridges the gap between the Worker Thread (Agent Runtime) and the Main Process (where LLM service lives).
 */

import { IAgentTool } from '../../domain/agents/tools.interface';
import { ChatService, DomainChatCompletionResult } from '../../domain/services/ChatService';
import { z } from 'zod';
import type { IAgentContext } from '../../domain/agents/agent-context.interface';

// ChatRole mapping helper if needed, or check if exported. 
// Assuming string is fine for domainMessages if mapped.
// Actually checking ChatService file again... ChatRole is NOT exported? 
// The file has interfaces, but ChatRole is specific. 
// Let's use string and cast as any if needed or just ChatMessage structure.
// DomainChatCompletionRequest uses 'message?: string'. 
// Wait, ChatService.complete doesn't exist on Stub ChatService.
// ChatService has `generateChatCompletion`.
// And `streamChatCompletion`.
// It does NOT have `complete`.
// I need to adapt LlmCompletionTool to use `generateChatCompletion`.

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'function']),
  content: z.string(),
  name: z.string().optional()
});

const PayloadSchema = z.object({
  messages: z.array(MessageSchema).min(1, "Must provide at least one message for completion"),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional()
});

export class LlmCompletionTool implements IAgentTool {
  public readonly name = 'llm_completion';
  public readonly description = 'Generate a text completion using the LLM. Use this to "think" or generate responses.';
  public readonly schema = z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant', 'system', 'function']),
      content: z.string(),
      name: z.string().optional()
    })).min(1),
    model: z.string().optional().default('gpt-4o').describe('The model to use for completion (e.g. gpt-4o)'),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional()
  });

  constructor(private readonly chatService: ChatService) {}

  private formatErrorResult(message: string) {
    return {
      content: [{ type: 'text' as const, text: `LLM Error: ${message}` }],
      isError: true,
    };
  }

  matches(name: string): boolean {
    return this.name === name;
  }

  async execute(args: unknown, context: IAgentContext): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      // 1. Validate Input
      const parsed = this.schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }

      const { messages, model, temperature, maxTokens } = parsed.data;

      // 2. Map to Domain Types
      const request = {
        model: model,
        messages: messages,
        temperature,
        maxTokens
      };

      // 3. Call Service
      const result = await this.chatService.generateChatCompletion(
        request,
        context.sessionId, // conversationId
        context.agentId // userId
      );

      if (!result.content) {
         throw new Error("Empty response from LLM");
      }

      // 4. Return Result
      return {
        content: [{ type: 'text', text: result.content }]
      };

    } catch (error) {
       return this.formatErrorResult(error instanceof Error ? error.message : String(error));
    }
  }
}
