/**
 * Send Message Tool
 * Layer: Infrastructure
 * 
 * Allows the Agent to send messages back to the conversation.
 * It wraps the SendMessageUseCase to be callable from the Agent Runtime.
 */

import { IAgentTool } from '../../domain/agents/tools.interface';
import type { ISendConversationMessage, SendConversationMessageInput } from '../../domain/conversation/ISendConversationMessage';
import { z } from 'zod';
import type { IAgentContext } from '../../domain/agents/agent-context.interface';



import { ILogger } from '../../core/decorators/ILogger';

export class SendMessageTool implements IAgentTool {
  public readonly name = 'send_message';
  public readonly description = 'Send a message to the current conversation.';
  public readonly schema = z.object({
    content: z.string().describe('The text content of the message'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata for the message')
  });

  constructor(
    private readonly sendMessageUseCase: ISendConversationMessage,
    private readonly logger?: ILogger
  ) {}

  matches(name: string): boolean {
    return this.name === name;
  }

  async execute(args: unknown, context: IAgentContext & { conversationId?: string; userId?: string }): Promise<{ content: string; metadata?: { messageId: string | undefined }; isError?: boolean }> {
    try {
      // 1. Validate Input
      const parsed = this.schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.message}`);
      }
      
      const { content, metadata } = parsed.data;
      const sessionId = context?.sessionId || context?.conversationId;
      const authorId = (context?.userId || context?.agentId) as string | undefined;

      if (!sessionId) throw new Error("Missing session/conversation ID in context");
      if (!authorId) throw new Error("Missing agent ID in context");

      // 2. Prepare UseCase Input
      const input: SendConversationMessageInput = {
        conversationId: sessionId,
        content: content,
        authorId: authorId,
        messageType: 'text',
        metadata: metadata
      };

      // 3. Execute Logic
      const result = await this.sendMessageUseCase.execute(input);

      if (!result.ok) {
         throw new Error(result.error?.message || "Failed to send message");
      }

      // 4. Return Result
      const messageId = result.data?.conversation?.id as string | undefined;
      return {
        content: JSON.stringify({ success: true, messageId }),
        metadata: { messageId },
      };

    } catch (error) {
      this.logger?.error('SendMessageTool Execution Failed', { 
        error: error instanceof Error ? error.message : String(error), 
        args, 
        sessionId: context?.sessionId 
      });
      return {
        content: `Error sending message: ${error instanceof Error ? error.message : String(error)}`,
        isError: true
      };
    }
  }
}
