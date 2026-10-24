/**
 * OpenAI-compatible chat completion adapter.
 * Layer: Infrastructure
 */

import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionOptions,
  ChatMessage,
  ChatToolCall,
  IChatCompletionModel,
} from '../../../domain/ai/IChatCompletionModel';

export interface OpenAICompatibleChatModelOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class OpenAICompatibleChatModel implements IChatCompletionModel {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAICompatibleChatModelOptions) {
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 0,
    });
  }

  async complete(messages: ChatMessage[], options: ChatCompletionOptions): Promise<ChatCompletion> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAiMessage),
        tools: options.tools?.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        max_tokens: options.maxOutputTokens,
      },
      {
        signal: options.signal,
        headers: { 'x-correlation-id': options.correlationId },
      },
    );

    const choice = response.choices[0];
    const toolCalls = mapToolCalls(choice?.message?.tool_calls);
    return {
      message: {
        role: 'assistant',
        content: choice?.message?.content ?? '',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model || this.model,
    };
  }
}

function toOpenAiMessage(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId ?? '',
    };
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    };
  }
  if (message.role === 'system') {
    return { role: 'system', content: message.content };
  }
  return { role: 'user', content: message.content };
}

function mapToolCalls(
  calls: OpenAI.Chat.ChatCompletionMessage['tool_calls'] | undefined,
): ChatToolCall[] {
  if (!calls) {
    return [];
  }
  const mapped: ChatToolCall[] = [];
  for (const call of calls) {
    if (call.type !== 'function') {
      continue;
    }
    const raw: unknown = call.function.arguments;
    mapped.push({
      id: call.id,
      name: call.function.name,
      argumentsJson: typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}),
    });
  }
  return mapped;
}

function mapFinishReason(reason: string | null | undefined): ChatCompletion['finishReason'] {
  if (reason === 'stop' || reason === 'tool_calls' || reason === 'length') {
    return reason;
  }
  return 'error';
}
