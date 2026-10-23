/**
 * OpenAIAdapter - адаптер для OpenAI API
 * Layer: Infrastructure
 *
 * Реализует IAIClient интерфейс для работы с OpenAI API.
 * Инкапсулирует специфику OpenAI и предоставляет унифицированный интерфейс.
 *
 * @example
 * ```typescript
 * import { getConfig } from '../../config';
 *
 * const cfg = getConfig();
 * const adapter = new OpenAIAdapter({
 *   apiKey: cfg.OPENAI_API_KEY,
 *   organization: cfg.OPENAI_ORG_ID
 * });
 *
 * const result = await adapter.generateText(
 *   "Напиши краткое описание TypeScript",
 *   { model: "gpt-4", temperature: 0.7, maxTokens: 500 }
 * );
 * ```
 */

import OpenAI from 'openai';
import { IAIClient, GenerateTextOptions, TextGenerationResult, GenerateEmbeddingsOptions, EmbeddingsResult, ModerateContentOptions, ModerationResult, TokenUsage } from '../../domain/ai/IAIClient';
import { Timestamp, now } from '../../core/types';
import { getConfig } from '../../config';
import { safeParseInt } from '../../core/config/safe-parse';

/**
 * Конфигурация OpenAI адаптера
 */
export interface OpenAIAdapterConfig {
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
}

/**
 * OpenAIAdapter - реализация IAIClient для OpenAI
 */
export class OpenAIAdapter implements IAIClient {
  private client: OpenAI;
  private config: OpenAIAdapterConfig;

  /**
   * Type guard для проверки OpenAI API ошибок
   */
  private isOpenAIError(error: unknown): error is { message: string; status?: number } {
    return typeof error === 'object' && error !== null && 'message' in error;
  }

  /**
   * Type guard для проверки OpenAI API ошибок с полным интерфейсом
   */
  private isOpenAIAPIError(error: unknown): error is { message: string; status: number } {
    return this.isOpenAIError(error) && 'status' in error && typeof (error as { status?: unknown }).status === 'number';
  }

  constructor(config: OpenAIAdapterConfig) {
    this.config = {
      timeoutMs: 30000,
      maxRetries: 3,
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
  async generateText(prompt: string, options: GenerateTextOptions): Promise<TextGenerationResult> {
    try {
      const startTime = process.hrtime.bigint();

      // Подготовка параметров для OpenAI
      const openaiParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: options.model || 'gpt-3.5-turbo',
        messages: [
          ...(options.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
          { role: 'user', content: prompt }
        ],
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stop: options.stopSequences,
      };

      // Выполнение запроса
      const response = await this.client.chat.completions.create(openaiParams);

      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;

      // Извлечение результата
      const choice = response.choices[0];
      if (!choice || !choice.message.content) {
        throw new Error('OpenAI вернул пустой ответ');
      }

      // Преобразование токенов OpenAI в унифицированный формат
      const usage: TokenUsage = {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      };

      return {
        text: choice.message.content,
        usage,
        model: response.model,
        generatedAt: now(),
        metadata: {
          finishReason: choice.finish_reason,
          durationMs,
          openaiVersion: response.object,
          ...options.metadata,
        },
      };

    } catch (error) {
      // Обработка ошибок OpenAI
      if (error instanceof OpenAI.APIError) {
        throw new Error(`OpenAI API Error: ${error.message} (Status: ${error.status})`);
      }
      throw new Error(`OpenAI request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Генерировать embeddings с помощью OpenAI
   */
  async generateEmbeddings(texts: string[], options: GenerateEmbeddingsOptions): Promise<EmbeddingsResult> {
    try {
      const startTime = process.hrtime.bigint();

      const response = await this.client.embeddings.create({
        model: options.model || 'text-embedding-ada-002',
        input: texts,
        encoding_format: 'float',
      });

      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;

      // Извлечение embeddings
      const embeddings = response.data.map(item => item.embedding);

      const usage: TokenUsage = {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: 0, // Embeddings не имеют completion tokens
        totalTokens: response.usage?.total_tokens || 0,
      };

      return {
        embeddings,
        usage,
        model: response.model,
        generatedAt: now(),
        metadata: {
          durationMs,
          inputCount: texts.length,
          ...options.metadata,
        },
      };

    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new Error(`OpenAI Embeddings API Error: ${error.message} (Status: ${error.status})`);
      }
      throw new Error(`OpenAI embeddings request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Модерировать контент с помощью OpenAI
   */
  async moderateContent(content: string, options?: ModerateContentOptions): Promise<ModerationResult> {
    try {
      const response = await this.client.moderations.create({
        model: options?.model || 'text-moderation-latest',
        input: content,
      });

      const result = response.results[0];
      if (!result) {
        throw new Error('OpenAI moderation вернул пустой результат');
      }

      // Определение категории нарушения
      const categories = Object.entries(result.categories)
        .filter(([_, flagged]) => flagged)
        .map(([category, _]) => category);

      return {
        approved: !result.flagged,
        confidence: Math.max(...Object.values(result.category_scores)),
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
      if (error instanceof OpenAI.APIError) {
        throw new Error(`OpenAI Moderation API Error: ${error.message} (Status: ${error.status})`);
      }
      throw new Error(`OpenAI moderation request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Проверить доступность OpenAI API
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Простой запрос для проверки доступности
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Получить список доступных моделей
   */
  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await this.client.models.list();
      return response.data
        .filter(model => model.id.includes('gpt') || model.id.includes('embedding'))
        .map(model => model.id)
        .sort();
    } catch (error) {
      console.warn('Failed to fetch OpenAI models:', error);
      // Возвращаем известные модели как fallback
      return [
        'gpt-4',
        'gpt-4-turbo',
        'gpt-3.5-turbo',
        'text-embedding-ada-002',
        'text-moderation-latest',
      ];
    }
  }

  /**
   * Получить конфигурацию адаптера
   */
  getConfig(): Readonly<OpenAIAdapterConfig> {
    return { ...this.config };
  }

  /**
   * Обновить конфигурацию
   */
  updateConfig(updates: Partial<OpenAIAdapterConfig>): void {
    this.config = { ...this.config, ...updates };

    // Пересоздание клиента с новой конфигурацией
    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      organization: this.config.organization,
      baseURL: this.config.baseURL,
      timeout: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
    });
  }
}

/**
 * Фабричная функция для создания OpenAI адаптера
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): IAIClient {
  return new OpenAIAdapter(config);
}

/**
 * Фабричная функция для создания OpenAI адаптера из конфигурации приложения
 */
export function createOpenAIAdapterFromEnv(): IAIClient {
  const config = getConfig();
  const apiKey = config.OPENAI_API_KEY;

  if (!apiKey || apiKey.length === 0) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const timeoutRaw = config.OPENAI_TIMEOUT_MS;
  const maxRetriesRaw = config.OPENAI_MAX_RETRIES;

  const timeoutMs = safeParseInt(timeoutRaw, undefined);
  const maxRetries = safeParseInt(maxRetriesRaw, undefined);

  return new OpenAIAdapter({
    apiKey,
    organization: config.OPENAI_ORG_ID,
    baseURL: config.OPENAI_BASE_URL,
    timeoutMs,
    maxRetries,
  });
}