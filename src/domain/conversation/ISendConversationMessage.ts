/**
 * Port used by the send-message tool. The use case stays in application.
 * Layer: Domain
 */

export interface SendConversationMessageInput {
  conversationId: string;
  authorId: string;
  content: string;
  messageType?: 'text' | 'image' | 'file' | 'system';
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface ISendConversationMessage {
  execute(input: SendConversationMessageInput): Promise<{
    ok: boolean;
    error?: { message?: string };
    data?: { conversation?: { id?: string } };
  }>;
}
