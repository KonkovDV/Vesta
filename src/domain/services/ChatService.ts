/**
 * ChatService (stub) — доменный сервис-заглушка для компиляции BFF
 * Layer: Domain
 *
 * Предоставляет минимальные методы, вызываемые ChatController.
 * Возвращает фиксированные данные/заглушки, достаточные для typecheck и базового запуска.
 */

/**
 * Domain-level DTOs для ChatService.
 * ВНИМАНИЕ: не импортировать protocol-слой в домен.
 */
import type { TipInjectionResult } from '../memory/IAdaptiveMemoryRetrieval';

export interface DomainModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  permission: unknown[];
  root: string;
  parent: string;
}

export interface DomainServerProperties {
  models: DomainModelInfo[];
  capabilities: {
    multimodal: boolean;
    tools: boolean;
    reasoning: boolean;
    stream: boolean;
  };
  limits: {
    max_context_length: number;
    max_tokens_per_request: number;
    supported_formats: string[];
  };
  sampling_options: {
    temperature_range: [number, number];
    top_p_range: [number, number];
    top_k_range: [number, number];
    repeat_penalty_range: [number, number];
  };
}

export interface DomainProcessingState {
  status: 'idle' | 'preparing' | 'generating';
  tokensDecoded: number;
  tokensRemaining: number;
  contextUsed: number;
  contextTotal: number;
  outputTokensUsed: number;
  outputTokensMax: number;
  hasNextToken: boolean;
  tokensPerSecond: number;
  temperature: number;
  topP: number;
  speculative: boolean;
  progressPercent?: number;
  promptTokens: number;
  cacheTokens: number;
}

/**
 * Тайминги генерации для доменного слоя.
 * Структура совместима с ChatMessageTimings из protocol/chat.ts, но определена в Domain.
 */
export interface ChatMessageTimings {
  prompt_n: number;
  predicted_n: number;
  predicted_ms: number;
  cache_n: number;
}

/**
 * Прогресс обработки промпта для доменного слоя.
 * Структура совместима с ChatMessagePromptProgress из protocol/chat.ts, но определена в Domain.
 */
export interface ChatMessagePromptProgress {
  total: number;
  cache: number;
  processed: number;
  time_ms: number;
}

export interface DomainChatCompletionRequest {
  model?: string;
  message?: string;
  [key: string]: unknown;
}

export interface DomainChatCompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DomainChatCompletionResult {
  content: string;
  reasoning?: string;
  timings?: ChatMessageTimings;
  model?: string;
  reasoningContent?: string;
  usage?: DomainChatCompletionUsage;
  tipInjection?: TipInjectionResult;
}

export class ChatService {
  async getServerProperties(): Promise<DomainServerProperties> {
    const created = Math.floor(Date.now() / 1000);
    return {
      models: [
        {
          id: 'stub-model',
          object: 'model',
          created,
          owned_by: 'stub-owner',
          permission: [],
          root: 'stub-model',
          parent: 'stub-model'
        }
      ],
      capabilities: {
        multimodal: false,
        tools: false,
        reasoning: false,
        stream: true
      },
      limits: {
        max_context_length: 8192,
        max_tokens_per_request: 2048,
        supported_formats: ['json', 'text/event-stream']
      },
      sampling_options: {
        temperature_range: [0, 2],
        top_p_range: [0, 1],
        top_k_range: [0, 200],
        repeat_penalty_range: [0, 2]
      }
    };
  }

  async getProcessingState(conversationId: string, userId: string): Promise<DomainProcessingState> {
    return {
      status: 'idle',
      tokensDecoded: 0,
      tokensRemaining: 0,
      contextUsed: 0,
      contextTotal: 8192,
      outputTokensUsed: 0,
      outputTokensMax: 2048,
      hasNextToken: false,
      tokensPerSecond: 0,
      temperature: 1,
      topP: 1,
      speculative: false,
      promptTokens: 0,
      cacheTokens: 0
    };
  }

  async streamChatCompletion(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
    handlers: {
      onChunk: (chunk: string) => void;
      onReasoningChunk?: (reasoningChunk: string) => void;
      onProgress?: (update: { timings?: ChatMessageTimings; prompt_progress?: ChatMessagePromptProgress }) => void;
      onComplete: (content: string, reasoning?: string, timings?: ChatMessageTimings, tipInjection?: TipInjectionResult) => void;
      onError: (error: Error) => void;
    }
  ): Promise<void> {
    try {
      // Демонстрационная "потоковая" отдача 1 чанка
      handlers.onChunk?.('stub-chunk');
      handlers.onReasoningChunk?.('stub-reasoning');
      handlers.onProgress?.({
        timings: { prompt_n: 0, predicted_n: 1, predicted_ms: 1, cache_n: 0 }
      });
      handlers.onComplete('stub-completion', 'stub-reasoning', { prompt_n: 0, predicted_n: 1, predicted_ms: 1, cache_n: 0 }, undefined);
    } catch (e) {
      handlers.onError(e instanceof Error ? e : new Error('Unknown streaming error'));
    }
  }

  async generateChatCompletion(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string
  ): Promise<DomainChatCompletionResult> {
    return {
      model: request.model || 'stub-model',
      content: 'stub non-stream completion',
      reasoningContent: undefined,
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2
      }
    };
  }

  async sendMessage(request: { message?: string; [key: string]: unknown }, userId: string): Promise<{ ok: boolean; userId: string; echo: { message?: string; [key: string]: unknown } }> {
    return { ok: true, userId, echo: request };
  }

  async regenerateMessage(messageId: string, userId: string): Promise<{ regenerated: boolean; messageId: string; userId: string }> {
    return { regenerated: true, messageId, userId };
  }

  async stopGeneration(conversationId: string, userId: string): Promise<void> {
    // Ничего не делаем в заглушке
    return;
  }

  async recordTipFeedback(_tipIds: string[], _helpful: boolean, _userId: string, _responseId?: string, _comment?: string): Promise<void> {
    // Ничего не делаем в заглушке
    return;
  }
}