/**
 * Anthropic Messages adapter for the chat-completion port.
 * Layer: Infrastructure
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  TextBlockParam,
  Tool,
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
const EPHEMERAL = { type: 'ephemeral' } as const;

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
    const tools = toAnthropicTools(options.tools ?? []);
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(translated.system ? { system: translated.system } : {}),
        messages: translated.messages,
        ...(tools.length > 0 ? { tools } : {}),
      },
      {
        signal: options.signal,
        headers: { 'x-correlation-id': options.correlationId },
      },
    );

    return toChatCompletion(response, this.model);
  }
}

/**
 * The prompt is laid out for prefix caching (tools, then system, then messages):
 * - `system` holds only the system messages that come before the conversation.
 *   A system message later in the list (the function_results catalog changes every
 *   step) is sent as a text block of the last user turn instead; merged into
 *   `system` it changed the prefix and voided the cache on every step.
 * - cache_control marks the end of tools, of system, and of the last message, so
 *   the next step reads the whole earlier conversation from cache.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: TextBlockParam[]; messages: MessageParam[] } {
  const systemParts: string[] = [];
  const lateNotes: string[] = [];
  const translated: MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) {
        (translated.length === 0 ? systemParts : lateNotes).push(message.content);
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
      // The API rejects an empty text block; an empty turn keeps the plain string form.
      content: message.content ? [{ type: 'text', text: message.content }] : message.content,
    });
  }

  if (translated.length === 0) {
    throw new Error('AnthropicChatModel requires at least one non-system message');
  }

  if (lateNotes.length > 0) {
    const note: TextBlockParam = { type: 'text', text: `<system-note>\n${lateNotes.join('\n\n')}\n</system-note>` };
    const last = translated.at(-1);
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.push(note);
    } else {
      translated.push({ role: 'user', content: [note] });
    }
  }

  markLastBlockForCache(translated);

  return {
    ...(systemParts.length > 0
      ? { system: [{ type: 'text', text: systemParts.join('\n\n'), cache_control: EPHEMERAL }] }
      : {}),
    messages: translated,
  };
}

function toAnthropicTools(tools: NonNullable<ChatCompletionOptions['tools']>): Tool[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.inputSchema, type: 'object' as const },
    ...(index === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
}

function markLastBlockForCache(messages: MessageParam[]): void {
  const last = messages.at(-1);
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const block = last.content[last.content.length - 1] as { cache_control?: typeof EPHEMERAL; type: string };
  if (block.type === 'text' || block.type === 'tool_result' || block.type === 'tool_use') {
    block.cache_control = EPHEMERAL;
  }
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

/** A malformed history entry must not fail every later step of the run. */
function parseToolInput(argumentsJson: string): unknown {
  if (argumentsJson.trim() === '') {
    return {};
  }
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { invalid_json: argumentsJson };
  }
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
      // input_tokens excludes cached tokens; the run budget counts all input processed.
      inputTokens: (response.usage?.input_tokens ?? 0)
        + (response.usage?.cache_creation_input_tokens ?? 0)
        + (response.usage?.cache_read_input_tokens ?? 0),
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
