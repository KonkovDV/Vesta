/**
 * Chat Protocol Layer - API контракты для чат-функциональности
 * Layer: Protocol
 *
 * Определяет типы и интерфейсы для BFF API чата,
 * адаптированные из WebUI паттернов для MicroPhoenix архитектуры.
 */

import { Timestamp } from '../core/types';

// ============================================================================
// Базовые типы сообщений
// ============================================================================

export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatMessageType = 'text' | 'root';
export type MessageAttachmentType = 'imageFile' | 'textFile' | 'audioFile' | 'pdfFile';

// ============================================================================
// API Request/Response типы
// ============================================================================

/**
 * Сообщение в формате API
 */
export interface ApiChatMessageData {
  role: ChatRole;
  content: string | ApiChatMessageContentPart[];
}

/**
 * Многочастный контент сообщения (для вложений)
 */
export interface ApiChatMessageContentPart {
  type: 'text' | 'image_url' | 'input_audio';
  text?: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: 'wav' | 'mp3' };
}

/**
 * Запрос на генерацию чата
 */
export interface ApiChatCompletionRequest {
  messages: ApiChatMessageData[];
  stream?: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning_format?: 'none' | 'auto';
  // Дополнительные параметры из WebUI
  dynatemp_range?: number;
  dynatemp_exponent?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  xtc_probability?: number;
  xtc_threshold?: number;
  typ_p?: number;
  repeat_last_n?: number;
  repeat_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  samplers?: string[];
  custom?: Record<string, unknown>;
  timings_per_token?: boolean;
}

export interface ApiTipInjectionMetadata {
  tips_injected: number;
  categories_represented: string[];
  tip_ids?: string[];
  injected_tips?: {
    tip_id: string;
    source_kind: 'tip' | 'principle';
    category: string;
  }[];
}

/**
 * Ответ на генерацию чата (non-streaming)
 */
export interface ApiChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: ChatRole;
      content: string;
      reasoning_content?: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tip_injection?: ApiTipInjectionMetadata;
}

/**
 * Чанк стримингового ответа
 */
export interface ApiChatCompletionStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      content?: string;
      reasoning_content?: string;
      role?: ChatRole;
    };
    finish_reason?: string;
  }[];
  timings?: ChatMessageTimings;
  prompt_progress?: ChatMessagePromptProgress;
}

/**
 * Тайминги генерации
 */
export interface ChatMessageTimings {
  prompt_n: number;
  predicted_n: number;
  predicted_ms: number;
  cache_n: number;
}

/**
 * Прогресс обработки промпта
 */
export interface ChatMessagePromptProgress {
  total: number;
  cache: number;
  processed: number;
  time_ms: number;
}

// ============================================================================
// Состояние обработки и слоты
// ============================================================================

/**
 * Состояние обработки AI
 */
export interface ApiProcessingState {
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

// ============================================================================
// Свойства сервера
// ============================================================================

/**
 * Свойства llama.cpp сервера
 */
export interface ApiLlamaCppServerProps {
  models: {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    permission: unknown[];
    root: string;
    parent: string;
  }[];
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

// ============================================================================
// Управление разговорами
// ============================================================================

/**
 * Разговор в базе данных
 */
export interface DatabaseConversation {
  id: string;
  name: string;
  created: Timestamp;
  lastModified: Timestamp;
  currNode: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Сообщение в базе данных
 */
export interface DatabaseMessage {
  id: string;
  convId: string;
  role: ChatRole;
  content: string;
  type: ChatMessageType;
  timestamp: Timestamp;
  parent: string | null;
  children: string[];
  thinking?: string;
  model?: string;
  timings?: ChatMessageTimings;
  extra?: DatabaseMessageExtra[];
}

/**
 * Дополнительные данные сообщения (вложения)
 */
export type DatabaseMessageExtra =
  | DatabaseMessageExtraImageFile
  | DatabaseMessageExtraTextFile
  | DatabaseMessageExtraAudioFile
  | DatabaseMessageExtraPdfFile
  | DatabaseMessageExtraLegacyContext;

/**
 * Изображение
 */
export interface DatabaseMessageExtraImageFile {
  type: 'imageFile';
  name: string;
  base64Url: string;
  mimeType: string;
}

/**
 * Текстовый файл
 */
export interface DatabaseMessageExtraTextFile {
  type: 'textFile';
  name: string;
  content: string;
  mimeType: string;
}

/**
 * Аудио файл
 */
export interface DatabaseMessageExtraAudioFile {
  type: 'audioFile';
  name: string;
  base64Data: string;
  mimeType: string;
}

/**
 * PDF файл
 */
export interface DatabaseMessageExtraPdfFile {
  type: 'pdfFile';
  name: string;
  content: string;
  processedAsImages?: boolean;
  images?: string[];
  mimeType: string;
}

/**
 * Устаревший контекст (legacy)
 */
export interface DatabaseMessageExtraLegacyContext {
  type: 'context';
  name: string;
  content: string;
}

// ============================================================================
// BFF API Request/Response типы
// ============================================================================

/**
 * Запрос на отправку сообщения
 */
export interface SendMessageRequest {
  content: string;
  conversationId?: string;
  attachments?: MessageAttachment[];
}

/**
 * Вложение в сообщении
 */
export interface MessageAttachment {
  type: MessageAttachmentType;
  name: string;
  content?: string;
  base64Url?: string;
  base64Data?: string;
  mimeType?: string;
  processedAsImages?: boolean;
  images?: string[];
}

/**
 * Ответ на отправку сообщения
 */
export interface SendMessageResponse {
  messageId: string;
  conversationId: string;
  streaming: boolean;
}

/**
 * Запрос на остановку генерации
 */
export interface StopGenerationRequest {
  conversationId: string;
}

/**
 * Запрос на создание разговора
 */
export interface CreateConversationRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Ответ с разговором
 */
export interface ConversationResponse {
  id: string;
  name: string;
  created: Timestamp;
  lastModified: Timestamp;
  currNode: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Запрос на обновление разговора
 */
export interface UpdateConversationRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Ответ со списком разговоров
 */
export interface ConversationsListResponse {
  conversations: ConversationResponse[];
  total: number;
}

/**
 * Запрос на экспорт разговоров
 */
export interface ExportConversationsRequest {
  conversationIds?: string[];
  includeMetadata?: boolean;
  format?: 'json' | 'csv';
}

/**
 * Ответ на экспорт
 */
export interface ExportConversationsResponse {
  data: string; // base64 encoded
  filename: string;
  format: string;
}

/**
 * Запрос на импорт разговоров
 */
export interface ImportConversationsRequest {
  data: string; // base64 encoded JSON
  mergeStrategy?: 'skip' | 'overwrite' | 'create_copy';
}

/**
 * Ответ на импорт
 */
export interface ImportConversationsResponse {
  imported: number;
  skipped: number;
  conflicts: {
    conversation_id: string;
    reason: 'duplicate_name' | 'invalid_format';
  }[];
}

/**
 * Универсальный тип загруженного файла (Node/multer или совместимый объект в тестах)
 */
/**
 * Lightweight, framework-agnostic file shape to avoid hard dependency on @types/multer.
 * Compatible with typical fields provided by upload middlewares.
 */
export type UploadedFile = {
  buffer?: Buffer;
  originalname?: string;
  name?: string;
  mimetype?: string;
  type?: string;
  size?: number;
  length?: number;
  destination?: string;
  filename?: string;
  path?: string;
};

/**
 * Запрос на загрузку файла
 */
export interface FileUploadRequest {
  file: UploadedFile;
  conversationId?: string;
  processAsImages?: boolean;
}

/**
 * Ответ на загрузку файла
 */
export interface FileUploadResponse {
  id: string;
  type: MessageAttachmentType;
  name: string;
  size: number;
  mimeType: string;
  processedAsImages?: boolean;
  images?: string[];
  content?: string;
  base64Url?: string;
  base64Data?: string;
}

// ============================================================================
// Ошибки
// ============================================================================

/**
 * Ошибка API
 */
export interface ApiErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * Ошибки BFF
 */
export enum BFFErrorCode {
  INVALID_REQUEST = 'INVALID_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  CONTEXT_LENGTH_EXCEEDED = 'CONTEXT_LENGTH_EXCEEDED',
  FILE_PROCESSING_ERROR = 'FILE_PROCESSING_ERROR',
  STREAM_INTERRUPTED = 'STREAM_INTERRUPTED',
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
  CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND',
  MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND',
}

// ============================================================================
// WebSocket/SSE типы для real-time
// ============================================================================

/**
 * Сообщение WebSocket/SSE
 */
export interface StreamMessage {
  type: 'token' | 'reasoning' | 'complete' | 'error' | 'progress';
  data: {
    token?: string;
    reasoning?: string;
    complete?: boolean;
    progress?: ApiProcessingState;
    error?: ApiErrorResponse;
  };
  timestamp: Timestamp;
  conversationId: string;
}

// ============================================================================
// Настройки и конфигурация
// ============================================================================

/**
 * Настройки чата
 */
export interface ChatSettings {
  // Model settings
  modelSelectorEnabled: boolean;
  selectedModel?: string;
  systemMessage?: string;

  // Generation parameters
  temperature?: number;
  max_tokens?: number;
  dynatemp_range?: number;
  dynatemp_exponent?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  xtc_probability?: number;
  xtc_threshold?: number;
  typ_p?: number;

  // Penalty parameters
  repeat_last_n?: number;
  repeat_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  dry_multiplier?: number;
  dry_base?: number;
  dry_allowed_length?: number;
  dry_penalty_last_n?: number;

  // Other
  samplers?: string[];
  custom?: Record<string, unknown>;
  timings_per_token?: boolean;

  // UI settings
  askForTitleConfirmation?: boolean;
  disableReasoningFormat?: boolean;

  // API settings
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Опции для ChatService
 */
export interface SettingsChatServiceOptions {
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  onComplete?: (response: string, reasoningContent?: string, timings?: ChatMessageTimings) => void;
  onError?: (error: Error) => void;
  onReasoningChunk?: (chunk: string) => void;
  onModel?: (model: string) => void;
  onFirstValidChunk?: () => void;

  // Generation parameters
  temperature?: number;
  max_tokens?: number;
  dynatemp_range?: number;
  dynatemp_exponent?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  xtc_probability?: number;
  xtc_threshold?: number;
  typ_p?: number;

  // Penalty parameters
  repeat_last_n?: number;
  repeat_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  dry_multiplier?: number;
  dry_base?: number;
  dry_allowed_length?: number;
  dry_penalty_last_n?: number;

  // Other parameters
  samplers?: string[];
  custom?: Record<string, unknown>;
  timings_per_token?: boolean;
}