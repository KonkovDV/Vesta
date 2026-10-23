/**
 * IAIClient - интерфейс для работы с AI сервисами
 * Layer: Domain (бизнес-логика)
 *
 * Определяет контракт для генерации текста и embeddings.
 * Следует принципу Dependency Inversion - Domain не зависит от конкретных AI провайдеров.
 *
 * @example
 * ```typescript
 * // Application Layer использует интерфейс
 * class TextGenerationService {
 *   constructor(private aiClient: IAIClient) {}
 *
 *   async generateResponse(prompt: string): Promise<string> {
 *     const response = await this.aiClient.generateText(prompt, {
 *       model: 'gpt-4',
 *       temperature: 0.7,
 *       maxTokens: 1000
 *     });
 *     return response.text;
 *   }
 * }
 * ```
 */

import { Timestamp } from '../../core/types';

/**
 * Опции для генерации текста
 */
export interface GenerateTextOptions {
  /** Модель для генерации */
  model: string;
  /** Температура (креативность) */
  temperature?: number;
  /** Максимальное количество токенов */
  maxTokens?: number;
  /** Системный промпт */
  systemPrompt?: string;
  /** Стоп-слова */
  stopSequences?: string[];
  /** Дополнительные параметры */
  metadata?: Record<string, unknown>;
}

/**
 * Результат генерации текста
 */
export interface TextGenerationResult {
  /** Сгенерированный текст */
  text: string;
  /** Информация об использовании токенов */
  usage: TokenUsage;
  /** Использованная модель */
  model: string;
  /** Время генерации */
  generatedAt: Timestamp;
  /** Дополнительные метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Опции для генерации embeddings
 */
export interface GenerateEmbeddingsOptions {
  /** Модель для генерации embeddings */
  model: string;
  /** Дополнительные параметры */
  metadata?: Record<string, unknown>;
}

/**
 * Результат генерации embeddings
 */
export interface EmbeddingsResult {
  /** Векторные представления */
  embeddings: number[][];
  /** Информация об использовании токенов */
  usage: TokenUsage;
  /** Использованная модель */
  model: string;
  /** Время генерации */
  generatedAt: Timestamp;
  /** Дополнительные метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Опции для модерации контента
 */
export interface ModerateContentOptions {
  /** Модель для модерации */
  model?: string;
  /** Дополнительные параметры */
  metadata?: Record<string, unknown>;
}

/**
 * Результат модерации контента
 */
export interface ModerationResult {
  /** Флаг одобрения контента */
  approved: boolean;
  /** Уровень уверенности модератора */
  confidence: number;
  /** Категории нарушений */
  categories: string[];
  /** Причина отклонения */
  reason?: string;
  /** Время модерации */
  moderatedAt: Timestamp;
  /** Дополнительные метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Информация об использовании токенов
 */
export interface TokenUsage {
  /** Количество входных токенов */
  promptTokens: number;
  /** Количество выходных токенов */
  completionTokens: number;
  /** Общее количество токенов */
  totalTokens: number;
}

/**
 * IAIClient - интерфейс для AI сервисов
 *
 * Определяет операции для работы с AI без привязки к конкретному провайдеру.
 * Реализация этого интерфейса будет в Infrastructure слое и может использовать:
 * - OpenAI API
 * - Anthropic Claude
 * - Google Gemini
 * - Локальные модели
 * - Mock реализации для тестов
 */
export interface IAIClient {
  /**
   * Генерировать текст на основе промпта
   *
   * @param prompt - Текстовый промпт
   * @param options - Опции генерации
   * @returns Результат генерации текста
   *
   * @example
   * ```typescript
   * const result = await aiClient.generateText(
   *   "Напиши краткое описание TypeScript",
   *   { model: "gpt-4", temperature: 0.7, maxTokens: 500 }
   * );
   * console.log(result.text);
   * ```
   */
  generateText(prompt: string, options: GenerateTextOptions): Promise<TextGenerationResult>;

  /**
   * Генерировать embeddings для текстов
   *
   * @param texts - Массив текстов для векторизации
   * @param options - Опции генерации
   * @returns Результат генерации embeddings
   *
   * @example
   * ```typescript
   * const result = await aiClient.generateEmbeddings(
   *   ["TypeScript", "JavaScript", "Python"],
   *   { model: "text-embedding-ada-002" }
   * );
   * console.log(result.embeddings); // [[0.1, 0.2, ...], ...]
   * ```
   */
  generateEmbeddings(texts: string[], options: GenerateEmbeddingsOptions): Promise<EmbeddingsResult>;

  /**
   * Модерировать контент на предмет нарушений
   *
   * @param content - Контент для проверки
   * @param options - Опции модерации
   * @returns Результат модерации
   *
   * @example
   * ```typescript
   * const result = await aiClient.moderateContent(
   *   "Некоторый пользовательский контент",
   *   { model: "text-moderation-latest" }
   * );
   * if (!result.approved) {
   *   console.log("Контент отклонен:", result.reason);
   * }
   * ```
   */
  moderateContent(content: string, options?: ModerateContentOptions): Promise<ModerationResult>;

  /**
   * Проверить доступность сервиса
   *
   * @returns true если сервис доступен
   */
  isAvailable(): Promise<boolean>;

  /**
   * Получить информацию о доступных моделях
   *
   * @returns Список доступных моделей
   */
  getAvailableModels(): Promise<string[]>;
}