/**
 * Anthropic Messages adapter for the chat-completion port.
 * Layer: Infrastructure
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  ChatCompletion,
  ChatCompletionOptions,
  ChatMessage,
  ChatToolCall,
  IChatCompletionModel,
} from '../../../domain/ai/IChatCompletionModel';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface AnthropicChatModelOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class AnthropicChatModel implements IChatCompletionModel {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicChatModelOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 0,
    });
  }

  async complete(messages: ChatMessage[], options: ChatCompletionOptions): Promise<ChatCompletion> {
    const translated = toAnthropicMessages(messages);
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(translated.system ? { system: translated.system } : {}),
        messages: translated.messages,
        ...(options.tools && options.tools.length > 0
          ? {
              tools: options.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: { ...tool.inputSchema, type: 'object' as const },
              })),
            }
          : {}),
      },
      {
        signal: options.signal,
        headers: { 'x-correlation-id': options.correlationId },
      },
    );

    return toChatCompletion(response, this.model);
  }
}

function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: MessageParam[] } {
  const systemParts: string[] = [];
  const translated: MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) {
        systemParts.push(message.content);
      }
      continue;
    }
    if (message.role === 'tool') {
      appendToolResult(translated, {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const content: Array<{ type: 'text'; text: string } | ToolUseBlockParam> = [];
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseToolInput(call.argumentsJson),
        });
      }
      translated.push({ role: 'assistant', content });
      continue;
    }
    translated.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    });
  }

  if (translated.length === 0) {
    throw new Error('AnthropicChatModel requires at least one non-system message');
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: translated,
  };
}

function appendToolResult(messages: MessageParam[], block: ToolResultBlockParam): void {
  const last = messages.at(-1);
  if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every(isToolResult)) {
    last.content.push(block);
    return;
  }
  messages.push({ role: 'user', content: [block] });
}

function isToolResult(block: unknown): block is ToolResultBlockParam {
  return typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result';
}

function parseToolInput(argumentsJson: string): unknown {
  if (argumentsJson.trim() === '') {
    return {};
  }
  return JSON.parse(argumentsJson) as unknown;
}

function toChatCompletion(response: Message, fallbackModel: string): ChatCompletion {
  const text = response.content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const toolCalls = response.content
    .filter((block): block is Extract<Message['content'][number], { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block): ChatToolCall => ({
      id: block.id,
      name: block.name,
      argumentsJson: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
    }));

  return {
    message: {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    finishReason: mapStopReason(response.stop_reason),
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    model: response.model || fallbackModel,
  };
}

function mapStopReason(reason: Message['stop_reason']): ChatCompletion['finishReason'] {
  if (reason === 'tool_use') {
    return 'tool_calls';
  }
  if (reason === 'end_turn' || reason === 'stop_sequence') {
    return 'stop';
  }
  if (reason === 'max_tokens') {
    return 'length';
  }
  return 'error';
}
