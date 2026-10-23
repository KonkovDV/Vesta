/**
 * OpenAILLMAdapter - адаптер для OpenAI API
 * Layer: Infrastructure
 * 
 * Реализует ILLMAdapter интерфейс для работы с OpenAI API.
 * Поддерживает генерацию текста, эмбеддингов, модерацию и стриминг.
 */

import OpenAI from 'openai';
import { CircuitOpenError } from '../resilience/InMemoryCircuitBreaker';
import {
  ILLMAdapter,
  LLMGenerateOptions,
  LLMGenerationResult,
  LLMEmbeddingOptions,
  LLMEmbeddingResult,
  LLMModerationOptions,
  LLMModerationResult,
  LLMModelInfo,
  LLMStreamCallback,
  LLMAdapterError,
  BaseLLMAdapter,
  LLMMultimodalGenerateOptions,
} from '../../domain/ai/ILLMAdapter';
import { now } from '../../core/types';
import { MultimodalChatMessage } from '../../core/llm/multimodal-types';
import { getConfig } from '../../config';
import { safeParseInt } from '../../core/config/safe-parse';
import {
  LLMProviderError,
  handleProviderError,
} from './errors/llm-provider-error';

const MAX_IMAGE_BASE64_LENGTH = 2_000_000;
/**
 * OpenAI Vision в текущей конфигурации поддерживает не более одного изображения на запрос.
 * Значение должно быть синхронизировано с capabilities в LLMAdapterFactory.
 */
const MAX_IMAGES_PER_REQUEST = 1;

 /**
  * Конфигурация OpenAI адаптера
  */
export interface OpenAILLMAdapterConfig {
  /** API ключ OpenAI */
  apiKey: string;
  
  /** ID организации */
  organization?: string;
  
  /** Базовый URL API */
  baseURL?: string;
  
  /** Таймаут запросов в миллисекундах */
  timeoutMs?: number;
  
  /** Максимальное количество повторных попыток */
  maxRetries?: number;
  
  /** Дефолтная модель для генерации */
  defaultModel?: string;
  
  /** Дефолтная модель для эмбеддингов */
  defaultEmbeddingModel?: string;
  
  /** Дефолтная модель для модерации */
  defaultModerationModel?: string;
}

/**
 * OpenAI адаптер
 */
export class OpenAILLMAdapter extends BaseLLMAdapter implements ILLMAdapter {
  private client: OpenAI;
  private config: Required<OpenAILLMAdapterConfig>;

  constructor(config: OpenAILLMAdapterConfig) {
    super();
    
    this.config = {
      timeoutMs: 30000,
      maxRetries: 3,
      defaultModel: 'gpt-3.5-turbo',
      defaultEmbeddingModel: 'text-embedding-ada-002',
      defaultModerationModel: 'text-moderation-latest',
      organization: config.organization || '',
      baseURL: config.baseURL || '',
      ...config
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      organization: this.config.organization,
      baseURL: this.config.baseURL,
      timeout: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
    });
  }

  /**
   * Генерировать текст с помощью OpenAI
   */
  async generateText(prompt: string, options?: LLMGenerateOptions): Promise<LLMGenerationResult> {
    try {
      const startTime = Date.now();
      
      // Валидация параметров
      this.validateGenerateOptions(options || {});
      
      // Нормализация промпта
      const normalizedPrompt = this.normalizePrompt(prompt);
      
      // Подготовка сообщений
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      
      // Добавляем системный промпт если есть
      if (options?.systemPrompt) {
        messages.push({
          role: 'system',
          content: options.systemPrompt
        });
      }
      
      // Добавляем пользовательский промпт
      messages.push({
        role: 'user',
        content: normalizedPrompt
      });

      // Подготовка параметров
      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: options?.model || this.config.defaultModel,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        stop: options?.stopSequences,
      };

      // Выполнение запроса
      const response = await this.client.chat.completions.create(params);

      const endTime = Date.now();
      
      // Извлечение результата
      const choice = response.choices[0];
      if (!choice || !choice.message.content) {
        throw new Error('OpenAI вернул пустой ответ');
      }

      // Формирование результата
      return {
        text: choice.message.content,
        model: response.model,
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
        generatedAt: now(),
        metadata: {
          finishReason: choice.finish_reason,
          durationMs: endTime - startTime,
          openaiVersion: response.object,
          ...options?.metadata,
        },
        finishReason: choice.finish_reason || undefined,
      };

    } catch (error) {
      this.handleError(error, 'generateText');
    }
  }

  /**
   * Генерировать текст с стримингом
   */
  async generateTextStream(
    prompt: string,
    callback: LLMStreamCallback,
    options?: LLMGenerateOptions
  ): Promise<LLMGenerationResult> {
    try {
      const startTime = Date.now();
      
      // Валидация параметров
      this.validateGenerateOptions(options || {});
      
      // Нормализация промпта
      const normalizedPrompt = this.normalizePrompt(prompt);
      
      // Подготовка сообщений
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      
      if (options?.systemPrompt) {
        messages.push({
          role: 'system',
          content: options.systemPrompt
        });
      }
      
      messages.push({
        role: 'user',
        content: normalizedPrompt
      });

      // Подготовка параметров для стриминга
      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: options?.model || this.config.defaultModel,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        stop: options?.stopSequences,
        stream: true,
      };

      // Выполнение стримингового запроса
      const stream = await this.client.chat.completions.create(params);
      
      let fullText = '';
      
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullText += content;
          callback(content);
        }
      }

      const endTime = Date.now();

      // Получаем финальную информацию об использовании токенов
      // Для стриминга нужно дополнительно запросить usage
      const usage = {
        promptTokens: 0, // Для стриминга точное количество неизвестно
        completionTokens: 0,
        totalTokens: 0,
      };

      return {
        text: fullText,
        model: params.model,
        usage,
        generatedAt: now(),
        metadata: {
          durationMs: endTime - startTime,
          streaming: true,
          ...options?.metadata,
        },
      };

    } catch (error) {
      this.handleError(error, 'generateTextStream');
    }
  }

  /**
   * Генерировать ответ для мультимодального чата через OpenAI Vision.
   */
  async generateMultimodalChat(
    messages: MultimodalChatMessage[],
    options?: LLMMultimodalGenerateOptions
  ): Promise<LLMGenerationResult> {
    try {
      const startTime = Date.now();

      if (!messages || messages.length === 0) {
        throw new LLMAdapterError(
          'Multimodal chat requires at least one message',
          'openai',
          'generate_multimodal_chat'
        );
      }

      const hasText = messages.some(message =>
        message.parts.some(
          part =>
            part.type === 'text' &&
            typeof part.text === 'string' &&
            part.text.trim().length > 0
        )
      );
      const hasImage = messages.some(message =>
        message.parts.some(part => part.type === 'image')
      );

      if (!hasText && !hasImage) {
        throw new LLMAdapterError(
          'Multimodal chat requires at least text or image content',
          'openai',
          'generate_multimodal_chat'
        );
      }

      // Валидация общих параметров генерации
      this.validateGenerateOptions(options || {});

      // Если изображений нет, используем базовый текстовый путь.
      if (!hasImage) {
        return super.generateMultimodalChat(messages, options);
      }

      // Базовая валидация payload'ов изображений и лимита на их количество.
      let imageCount = 0;

      for (const message of messages) {
        for (const part of message.parts) {
          if (part.type === 'image') {
            imageCount++;

            const base64 =
              typeof part.imageBase64 === 'string'
                ? part.imageBase64.trim()
                : '';

            if (base64.length === 0) {
              throw new Error(
                'Multimodal chat image payload must be a non-empty base64 string'
              );
            }

            if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
              throw new Error(
                `Multimodal chat image payload is too large. Maximum allowed base64 length is ${MAX_IMAGE_BASE64_LENGTH} characters`
              );
            }
          }
        }
      }

      if (imageCount > MAX_IMAGES_PER_REQUEST) {
        throw new Error(
          `Multimodal chat supports up to ${MAX_IMAGES_PER_REQUEST} image(s) per request for provider openai`
        );
      }

      if (
        options?.expectedModality &&
        !options.expectedModality.includes('image')
      ) {
        // Best-effort: игнорируем конфликт expectedModality и реального контента.
      }

      const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (options?.systemPrompt) {
        openaiMessages.push({
          role: 'system',
          content: options.systemPrompt,
        });
      }

      for (const message of messages) {
        const textParts: string[] = [];
        type ContentPart =
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string } };
        const contentParts: ContentPart[] = [];

        for (const part of message.parts) {
          if (part.type === 'text' && typeof part.text === 'string') {
            const text = part.text.trim();
            if (text) {
              textParts.push(text);
              contentParts.push({
                type: 'text',
                text,
              });
            }
          } else if (part.type === 'image' && typeof part.imageBase64 === 'string') {
            const imageUrl = part.imageBase64.trim();
            if (imageUrl) {
              contentParts.push({
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                },
              });
            }
          }
        }

        const hasAnyContent = contentParts.length > 0 || textParts.length > 0;
        if (!hasAnyContent) {
          continue;
        }

        if (message.role === 'user') {
          openaiMessages.push({
            role: 'user',
            content: contentParts.length > 0 ? contentParts : textParts.join(' '),
          });
        } else if (message.role === 'system') {
          openaiMessages.push({
            role: 'system',
            content: textParts.join(' '),
          });
        } else {
          openaiMessages.push({
            role: 'assistant',
            content: textParts.join(' '),
          });
        }
      }

      if (openaiMessages.length === 0) {
        throw new LLMAdapterError(
          'Multimodal chat message mapping produced no content for OpenAI',
          'openai',
          'generate_multimodal_chat'
        );
      }

      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: options?.model || this.config.defaultModel,
        messages: openaiMessages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        stop: options?.stopSequences,
      };

      const response = await this.client.chat.completions.create(params);

      const endTime = Date.now();

      const choice = response.choices[0];
      if (!choice || !choice.message.content) {
        throw new Error('OpenAI вернул пустой ответ');
      }

      return {
        text: choice.message.content,
        model: response.model,
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
        generatedAt: now(),
        metadata: {
          finishReason: choice.finish_reason,
          durationMs: endTime - startTime,
          openaiVersion: response.object,
          multimodal: true,
          hasImage,
          hasText,
          ...options?.metadata,
        },
        finishReason: choice.finish_reason || undefined,
      };
    } catch (error) {
      this.handleError(error, 'generate_multimodal_chat');
    }
  }

  /**
   * Генерировать эмбеддинги с помощью OpenAI
   */
  async generateEmbeddings(texts: string[], options?: LLMEmbeddingOptions): Promise<LLMEmbeddingResult> {
    try {
      const startTime = Date.now();

      // Валидация входных данных
      if (!texts || texts.length === 0) {
        throw new Error('Texts array cannot be empty');
      }

      // Ограничение OpenAI: максимум 2048 текстов за раз
      if (texts.length > 2048) {
        throw new Error('OpenAI supports maximum 2048 texts per request');
      }

      const response = await this.client.embeddings.create({
        model: options?.model || this.config.defaultEmbeddingModel,
        input: texts,
        encoding_format: 'float',
        dimensions: options?.dimensions,
      });

      const endTime = Date.now();

      // Извлечение эмбеддингов
      const embeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map(item => item.embedding);

      return {
        embeddings,
        model: response.model,
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
        generatedAt: now(),
        metadata: {
          durationMs: endTime - startTime,
          inputCount: texts.length,
          ...options?.metadata,
        },
      };

    } catch (error) {
      this.handleError(error, 'generateEmbeddings');
    }
  }

  /**
   * Модерировать контент с помощью OpenAI
   */
  async moderateContent(content: string, options?: LLMModerationOptions): Promise<LLMModerationResult> {
    try {
      const response = await this.client.moderations.create({
        model: options?.model || this.config.defaultModerationModel,
        input: content,
      });

      const result = response.results[0];
      if (!result) {
        throw new Error('OpenAI moderation вернул пустой результат');
      }

      // Определение категорий нарушения
      const categories = Object.entries(result.categories)
        .filter(([_, flagged]) => flagged)
        .map(([category, _]) => category);

      // Находим максимальную уверенность
      const confidence = Math.max(...Object.values(result.category_scores));

      return {
        approved: !result.flagged,
        confidence,
        categories,
        reason: result.flagged ? `Нарушение категорий: ${categories.join(', ')}` : undefined,
        moderatedAt: now(),
        metadata: {
          model: response.model,
          categoryScores: result.category_scores,
          ...options?.metadata,
        },
      };

    } catch (error) {
      this.handleError(error, 'moderateContent');
    }
  }

  /**
   * Получить список доступных моделей OpenAI
   */
  async getAvailableModels(): Promise<LLMModelInfo[]> {
    try {
      const response = await this.client.models.list();
      
      return response.data
        .filter(model => {
          // Фильтруем только модели, которые нам нужны
          const modelId = model.id.toLowerCase();
          return (
            modelId.includes('gpt') || 
            modelId.includes('embedding') || 
            modelId.includes('moderation')
          );
        })
        .map(model => {
          const modelId = model.id.toLowerCase();
          const isGPT = modelId.includes('gpt');
          const isEmbedding = modelId.includes('embedding');
          const isModeration = modelId.includes('moderation');
          
          return {
            id: model.id,
            name: model.id,
            provider: 'openai',
            capabilities: {
              chat: isGPT,
              embeddings: isEmbedding,
              moderation: isModeration,
              streaming: isGPT, // GPT модели поддерживают стриминг
            },
            limits: {
              maxTokens: isGPT ? 4096 : 0,
              maxContextLength: isGPT ? 
                (modelId.includes('gpt-4') ? 8192 : 4096) : 0,
            },
            metadata: {
              created: model.created,
              ownedBy: model.owned_by,
            },
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));

    } catch (error) {
      // Возвращаем fallback список если не удалось получить от API
      return [
        {
          id: 'gpt-4',
          name: 'GPT-4',
          provider: 'openai',
          capabilities: {
            chat: true,
            embeddings: false,
            moderation: false,
            streaming: true,
          },
          limits: {
            maxTokens: 4096,
            maxContextLength: 8192,
          },
        },
        {
          id: 'gpt-3.5-turbo',
          name: 'GPT-3.5 Turbo',
          provider: 'openai',
          capabilities: {
            chat: true,
            embeddings: false,
            moderation: false,
            streaming: true,
          },
          limits: {
            maxTokens: 4096,
            maxContextLength: 4096,
          },
        },
        {
          id: 'text-embedding-ada-002',
          name: 'Text Embedding Ada 002',
          provider: 'openai',
          capabilities: {
            chat: false,
            embeddings: true,
            moderation: false,
            streaming: false,
          },
          limits: {
            maxTokens: 0,
            maxContextLength: 0,
          },
        },
        {
          id: 'text-moderation-latest',
          name: 'Text Moderation Latest',
          provider: 'openai',
          capabilities: {
            chat: false,
            embeddings: false,
            moderation: true,
            streaming: false,
          },
          limits: {
            maxTokens: 0,
            maxContextLength: 0,
          },
        },
      ];
    }
  }

  /**
   * Проверить доступность OpenAI API
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Пробуем сделать простой запрос
      await this.client.models.list();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Получить информацию о провайдере
   */
  getProviderInfo(): {
    name: string;
    version: string;
    capabilities: string[];
  } {
    return {
      name: 'openai',
      version: '1.0.0',
      capabilities: ['chat', 'embeddings', 'moderation', 'streaming'],
    };
  }

  /**
   * Нормализация имени операции для LLMAdapterError.operation.
   * Преобразует имена методов адаптера в snake_case коды операций.
   */
  private normalizeOperation(operation: string): string {
    switch (operation) {
      case 'generateText':
      case 'generate_text':
        return 'generate_text';
      case 'generateTextStream':
      case 'generate_text_stream':
        return 'generate_text_stream';
      case 'generateMultimodalChat':
      case 'generate_multimodal_chat':
        return 'generate_multimodal_chat';
      case 'generateEmbeddings':
      case 'generate_embeddings':
        return 'generate_embeddings';
      case 'moderateContent':
      case 'moderate_content':
        return 'moderate_content';
      default:
        return operation;
    }
  }

  /**
   * Обработка ошибок
   */
  private handleError(error: unknown, operation: string): never {
    const normalizedOperation = this.normalizeOperation(operation);

    const anyError = error as { code?: unknown } | null | undefined;

    // Circuit breaker short-circuit: map to LLMAdapterError with explicit CIRCUIT_OPEN semantics.
    if (error instanceof CircuitOpenError || anyError?.code === 'CIRCUIT_OPEN') {
      const cause =
        error instanceof Error
          ? error
          : new Error(
              typeof error === 'string'
                ? error
                : 'Circuit breaker is OPEN',
            );
      const message =
        'OpenAI circuit is OPEN; downstream temporarily unavailable (calls short-circuited by resilience policy)';
      throw new LLMAdapterError(
        message,
        'openai',
        normalizedOperation,
        cause,
      );
    }

    if (error instanceof OpenAI.APIError) {
      throw new LLMProviderError(
        `OpenAI API Error: ${error.message} (Status: ${error.status})`,
        'openai',
        normalizedOperation,
        {
          status: error.status,
          code:
            typeof (error as unknown as Record<string, unknown>).code === 'string'
              ? ((error as unknown as Record<string, unknown>).code as string)
              : undefined,
          errorDetails: (error as unknown as Record<string, unknown>).error,
          cause: error,
        },
      );
    }

    throw handleProviderError(
      error instanceof Error ? error : new Error('Unknown error'),
      'OpenAI',
      normalizedOperation,
      { messagePrefix: 'request' },
    );
  }
}

/**
 * Фабричная функция для создания OpenAI адаптера
 */
export function createOpenAILLMAdapter(config: OpenAILLMAdapterConfig): OpenAILLMAdapter {
  return new OpenAILLMAdapter(config);
}

/**
 * Фабричная функция для создания OpenAI адаптера из конфигурации окружения
 */
export function createOpenAILLMAdapterFromEnv(): OpenAILLMAdapter {
  const config = getConfig();
  const apiKey = config.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const organization = config.OPENAI_ORG_ID;
  const baseURL = config.OPENAI_BASE_URL;
  const timeoutMs = safeParseInt(config.OPENAI_TIMEOUT_MS, undefined);
  const maxRetries = safeParseInt(config.OPENAI_MAX_RETRIES, undefined);

  return new OpenAILLMAdapter({
    apiKey,
    organization,
    baseURL,
    timeoutMs,
    maxRetries,
    defaultModel: config.OPENAI_DEFAULT_MODEL,
    defaultEmbeddingModel: config.OPENAI_DEFAULT_EMBEDDING_MODEL,
    defaultModerationModel: config.OPENAI_DEFAULT_MODERATION_MODEL,
  });
}