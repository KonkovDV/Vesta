/**
 * Chat completion port with tool-role history.
 * Layer: Domain
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present only when role is assistant. */
  toolCalls?: ChatToolCall[];
  /** Present only when role is tool. */
  toolCallId?: string;
}

export interface ChatToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatCompletion {
  message: ChatMessage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface ChatCompletionOptions {
  tools?: ChatToolSpec[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  correlationId: string;
}

export interface IChatCompletionModel {
  complete(messages: ChatMessage[], options: ChatCompletionOptions): Promise<ChatCompletion>;
}
