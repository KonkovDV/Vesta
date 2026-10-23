/**
 * ILLMAdapter - универсальный интерфейс для LLM провайдеров
 * Layer: Domain (бизнес-логика)
 * 
 * Предоставляет единый интерфейс для работы с различными LLM провайдерами:
 * - OpenAI (GPT-4, GPT-3.5)
 * - Anthropic (Claude)
 * - Local models (Llama, etc.)
 * - Custom models
 * 
 * Принципы:
 * - Абстракция от конкретного провайдера
 * - Унифицированные параметры и форматы
 * - Поддержка стриминга
 * - Обработка ошибок и retry логика
 */

import { Timestamp, now } from '../../core/types';
import {
  MultimodalChatMessage,
  MultimodalContentType,
} from '../../core/llm/multimodal-types';

/**
 * Параметры для генерации текста
 */
export interface LLMGenerateOptions {
  /** Модель для генерации */
  model?: string;
  
  /** Температура генерации (0-2) */
  temperature?: number;
  
  /** Максимальное количество токенов */
  maxTokens?: number;
  
  /** Стоп-последовательности */
  stopSequences?: string[];
  
  /** Системный промпт */
  systemPrompt?: string;
  
  /** Метаданные запроса */
  metadata?: Record<string, unknown>;
  
  /** Таймаут в миллисекундах */
  timeoutMs?: number;
  
  /** Включить стриминг */
  stream?: boolean;

  /** Tool definitions for function calling */
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;

  /** Tool choice strategy: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } } */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function?: { name: string } };
}

/**
 * Опции для мультимодальной генерации.
 * Используются только для generateMultimodalChat.
 */
export type LLMMultimodalGenerateOptions = LLMGenerateOptions & {
  /** Ожидаемые модальности в ответе или обработке. */
  expectedModality?: MultimodalContentType[];
};

/**
 * Параметры для генерации эмбеддингов
 */
export interface LLMEmbeddingOptions {
  /** Модель для эмбеддингов */
  model?: string;
  
  /** Размерность эмбеддинга */
  dimensions?: number;
  
  /** Формат эмбеддинга */
  format?: 'float' | 'base64';
  
  /** Метаданные запроса */
  metadata?: Record<string, unknown>;
}

/**
 * Результат генерации текста
 */
export interface LLMGenerationResult {
  /** Сгенерированный текст */
  text: string;
  
  /** Использованная модель */
  model: string;
  
  /** Использование токенов */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  
  /** Время генерации */
  generatedAt: Timestamp;
  
  /** Метаданные ответа */
  metadata?: Record<string, unknown>;
  
  /** Причина завершения */
  finishReason?: string;

  /** Tool call results from function-calling models */
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

/**
 * Результат генерации эмбеддингов
 */
export interface LLMEmbeddingResult {
  /** Эмбеддинги */
  embeddings: number[][];
  
  /** Использованная модель */
  model: string;
  
  /** Использование токенов */
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
  
  /** Время генерации */
  generatedAt: Timestamp;
  
  /** Метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Параметры для модерации контента
 */
export interface LLMModerationOptions {
  /** Модель для модерации */
  model?: string;
  
  /** Категории для проверки */
  categories?: string[];
  
  /** Метаданные запроса */
  metadata?: Record<string, unknown>;
}

/**
 * Результат модерации
 */
export interface LLMModerationResult {
  /** Одобрен ли контент */
  approved: boolean;
  
  /** Уровень уверенности (0-1) */
  confidence: number;
  
  /** Нарушенные категории */
  categories: string[];
  
  /** Причина отклонения */
  reason?: string;
  
  /** Время проверки */
  moderatedAt: Timestamp;
  
  /** Метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Информация о модели
 */
export interface LLMModelInfo {
  /** ID модели */
  id: string;
  
  /** Название модели */
  name: string;
  
  /** Провайдер */
  provider: string;
  
  /** Поддерживаемые возможности */
  capabilities: {
    chat: boolean;
    embeddings: boolean;
    moderation: boolean;
    streaming: boolean;
  };
  
  /** Ограничения модели */
  limits: {
    maxTokens: number;
    maxContextLength: number;
  };
  
  /** Метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Callback для стриминга
 */
export type LLMStreamCallback = (chunk: string) => void;

/**
 * ILLMAdapter - универсальный интерфейс для LLM провайдеров
 */
export interface ILLMAdapter {
  /**
   * Генерировать текст
   * 
   * @param prompt - Промпт для генерации
   * @param options - Параметры генерации
   * @returns Promise с результатом генерации
   */
  generateText(prompt: string, options?: LLMGenerateOptions): Promise<LLMGenerationResult>;
  
  /**
   * Генерировать текст с стримингом
   *
   * @param prompt - Промпт для генерации
   * @param callback - Callback для получения чанков
   * @param options - Параметры генерации
   * @returns Promise с полным результатом
   */
  generateTextStream(
    prompt: string,
    callback: LLMStreamCallback,
    options?: LLMGenerateOptions
  ): Promise<LLMGenerationResult>;

  /**
   * Генерировать ответ для мультимодального чата.
   *
   * Базовая реализация может сводить сообщения к текстовому промпту.
   * Адаптеры с нативной multimodal-поддержкой переопределяют поведение.
   */
  generateMultimodalChat(
    messages: MultimodalChatMessage[],
    options?: LLMMultimodalGenerateOptions
  ): Promise<LLMGenerationResult>;
  
  /**
   * Генерировать эмбеддинги
   *
   * @param texts - Тексты для эмбеддинга
   * @param options - Параметры эмбеддинга
   * @returns Promise с эмбеддингами
   */
  generateEmbeddings(texts: string[], options?: LLMEmbeddingOptions): Promise<LLMEmbeddingResult>;
  
  /**
   * Модерировать контент
   * 
   * @param content - Контент для проверки
   * @param options - Параметры модерации
   * @returns Promise с результатом модерации
   */
  moderateContent(content: string, options?: LLMModerationOptions): Promise<LLMModerationResult>;
  
  /**
   * Получить список доступных моделей
   * 
   * @returns Promise с массивом моделей
   */
  getAvailableModels(): Promise<LLMModelInfo[]>;
  
  /**
   * Проверить доступность провайдера
   * 
   * @returns true если провайдер доступен
   */
  isAvailable(): Promise<boolean>;
  
  /**
   * Получить информацию о провайдере
   * 
   * @returns Объект с информацией о провайдере
   */
  getProviderInfo(): {
    name: string;
    version: string;
    capabilities: string[];
  };
}

/**
 * Базовый класс для LLM адаптеров
 * Предоставляет общую функциональность
 */
export abstract class BaseLLMAdapter implements ILLMAdapter {
  abstract generateText(prompt: string, options?: LLMGenerateOptions): Promise<LLMGenerationResult>;
  
  abstract generateTextStream(
    prompt: string,
    callback: LLMStreamCallback,
    options?: LLMGenerateOptions
  ): Promise<LLMGenerationResult>;
  
  abstract generateEmbeddings(texts: string[], options?: LLMEmbeddingOptions): Promise<LLMEmbeddingResult>;
  
  abstract moderateContent(content: string, options?: LLMModerationOptions): Promise<LLMModerationResult>;
  
  abstract getAvailableModels(): Promise<LLMModelInfo[]>;
  
  abstract isAvailable(): Promise<boolean>;
  
  abstract getProviderInfo(): {
    name: string;
    version: string;
    capabilities: string[];
  };

  /**
   * Базовая реализация мультимодального чата через текстовый промпт.
   * Текстовые адаптеры используют её как fallback.
   */
  async generateMultimodalChat(
    messages: MultimodalChatMessage[],
    options?: LLMMultimodalGenerateOptions
  ): Promise<LLMGenerationResult> {
    const prompt = this.normalizePrompt(
      messages
        .map(message => {
          const textParts = message.parts
            .filter(part => part.type === 'text' && typeof part.text === 'string')
            .map(part => (part.text ?? '').trim())
            .filter(Boolean);

          if (textParts.length === 0) {
            return '';
          }

          return textParts.join(' ');
        })
        .filter(Boolean)
        .join('\n\n')
    );

    return this.generateText(prompt, options);
  }
  
  /**
   * Валидация параметров генерации
   */
  protected validateGenerateOptions(options: LLMGenerateOptions): void {
    if (options.temperature !== undefined && (options.temperature < 0 || options.temperature > 2)) {
      throw new Error('Temperature must be between 0 and 2');
    }
    
    if (options.maxTokens !== undefined && options.maxTokens < 1) {
      throw new Error('maxTokens must be positive');
    }
    
    if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
      throw new Error('timeoutMs must be non-negative');
    }
  }
  
  /**
   * Нормализация промпта
   */
  protected normalizePrompt(prompt: string): string {
    return prompt.trim();
  }
  
  /**
   * Расчет стоимости запроса (опционально)
   */
  protected calculateCost(promptTokens: number, completionTokens: number, model: string): number {
    // Базовая реализация, может быть переопределена
    return 0;
  }
}

/**
 * Ошибки LLM адаптера
 */
export class LLMAdapterError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly operation: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'LLMAdapterError';
  }
  
  static providerUnavailable(provider: string): LLMAdapterError {
    return new LLMAdapterError(
      `LLM provider ${provider} is unavailable`,
      provider,
      'health_check'
    );
  }
  
  static generationFailed(provider: string, cause?: Error): LLMAdapterError {
    return new LLMAdapterError(
      `Text generation failed for provider ${provider}`,
      provider,
      'generate_text',
      cause
    );
  }
  
  static streamingFailed(provider: string, cause?: Error): LLMAdapterError {
    return new LLMAdapterError(
      `Streaming generation failed for provider ${provider}`,
      provider,
      'generate_text_stream',
      cause
    );
  }
  
  static embeddingsFailed(provider: string, cause?: Error): LLMAdapterError {
    return new LLMAdapterError(
      `Embeddings generation failed for provider ${provider}`,
      provider,
      'generate_embeddings',
      cause
    );
  }
  
  static moderationFailed(provider: string, cause?: Error): LLMAdapterError {
    return new LLMAdapterError(
      `Content moderation failed for provider ${provider}`,
      provider,
      'moderate_content',
      cause
    );
  }
}

/**
 * Утилиты для работы с LLM адаптерами
 */
export class LLMUtils {
  /**
   * Сравнение моделей по возможностям
   */
  static compareModels(model1: LLMModelInfo, model2: LLMModelInfo): {
    betterForChat: LLMModelInfo | null;
    betterForEmbeddings: LLMModelInfo | null;
  } {
    const result = {
      betterForChat: null as LLMModelInfo | null,
      betterForEmbeddings: null as LLMModelInfo | null,
    };
    
    // Сравнение по чат-возможностям
    if (model1.capabilities.chat && !model2.capabilities.chat) {
      result.betterForChat = model1;
    } else if (!model1.capabilities.chat && model2.capabilities.chat) {
      result.betterForChat = model2;
    } else if (model1.capabilities.chat && model2.capabilities.chat) {
      // Сравнение по максимальной длине контекста
      if (model1.limits.maxContextLength > model2.limits.maxContextLength) {
        result.betterForChat = model1;
      } else {
        result.betterForChat = model2;
      }
    }
    
    // Сравнение по эмбеддингам
    if (model1.capabilities.embeddings && !model2.capabilities.embeddings) {
      result.betterForEmbeddings = model1;
    } else if (!model1.capabilities.embeddings && model2.capabilities.embeddings) {
      result.betterForEmbeddings = model2;
    }
    
    return result;
  }
  
  /**
   * Выбор лучшей модели для задачи
   */
  static selectBestModel(models: LLMModelInfo[], task: 'chat' | 'embeddings' | 'moderation'): LLMModelInfo | null {
    return models
      .filter(model => {
        switch (task) {
          case 'chat':
            return model.capabilities.chat;
          case 'embeddings':
            return model.capabilities.embeddings;
          case 'moderation':
            return model.capabilities.moderation;
          default:
            return false;
        }
      })
      .sort((a, b) => {
        // Сортировка по возможностям и ограничениям
        const score = (model: LLMModelInfo) => {
          let s = 0;
          if (model.capabilities.streaming) s += 10;
          if (model.limits.maxContextLength > 8000) s += 5;
          if (model.limits.maxTokens > 2000) s += 3;
          return s;
        };
        return score(b) - score(a);
      })[0] || null;
  }
  
  /**
   * Оценка сложности промпта
   */
  static estimatePromptComplexity(prompt: string): {
    length: number;
    estimatedTokens: number;
    complexity: 'low' | 'medium' | 'high';
  } {
    const length = prompt.length;
    // Примерная оценка: 1 токен ~ 4 символа для английского, ~ 2 символа для других языков
    const estimatedTokens = Math.ceil(length / 3);
    
    let complexity: 'low' | 'medium' | 'high';
    if (estimatedTokens < 100) {
      complexity = 'low';
    } else if (estimatedTokens < 1000) {
      complexity = 'medium';
    } else {
      complexity = 'high';
    }
    
    return { length, estimatedTokens, complexity };
  }
}