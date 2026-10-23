/**
 * Protocol Layer - API контракты и типы для всех доменов
 * Layer: Protocol
 *
 * Определяет унифицированные интерфейсы для межслойного взаимодействия,
 * обеспечивая четкие контракты между слоями архитектуры.
 */

// Экспорт всех протоколов
export * from './chat';

// Типы для общих протоколов
export interface ProtocolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  metadata?: {
    timestamp: string;
    correlationId?: string;
    version: string;
  };
}

export interface ProtocolRequest<T = unknown> {
  data: T;
  metadata?: {
    correlationId?: string;
    userId?: string;
    sessionId?: string;
  };
}

// Общие типы для пагинации
export interface PaginatedRequest {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// Общие типы для поиска и фильтрации
export interface SearchRequest {
  query?: string;
  filters?: Record<string, unknown>;
  includeMetadata?: boolean;
}

export interface FilterOptions {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'startsWith' | 'endsWith';
  value: unknown;
}

// Типы для файловых операций
export interface FileMetadata {
  name: string;
  size: number;
  mimeType: string;
  hash?: string;
  uploadedAt: string;
  uploadedBy?: string;
}

export interface FileUploadOptions {
  maxSize?: number;
  allowedTypes?: string[];
  processAsImages?: boolean;
  generateThumbnail?: boolean;
}

// Типы для аутентификации и авторизации
export interface AuthToken {
  token: string;
  type: 'bearer' | 'api-key';
  expiresAt?: string;
  scopes?: string[];
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  permissions: string[];
  metadata?: Record<string, unknown>;
}

// Типы для ошибок
export enum ProtocolErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
}

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  details?: Record<string, unknown>;
  correlationId?: string;
  timestamp: string;
}

// Типы для событий и уведомлений
export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  data: T;
  metadata: {
    timestamp: string;
    correlationId?: string;
    userId?: string;
    version: number;
  };
}

export interface NotificationMessage {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
  read?: boolean;
}

// Утилиты для работы с протоколами
export class ProtocolUtils {
  /**
   * Создает успешный ответ протокола
   */
  static success<T>(data: T, metadata?: ProtocolResponse['metadata']): ProtocolResponse<T> {
    return {
      success: true,
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        version: '1.0',
        ...metadata,
      },
    };
  }

  /**
   * Создает ошибочный ответ протокола
   */
  static error(
    code: ProtocolErrorCode,
    message: string,
    details?: Record<string, unknown>,
    correlationId?: string
  ): ProtocolResponse {
    const errDetails = correlationId
      ? { ...(details || {}), correlation_id: correlationId }
      : details;

    return {
      success: false,
      error: {
        code,
        message,
        details: errDetails,
      },
      metadata: {
        timestamp: new Date().toISOString(),
        version: '1.0',
        correlationId,
      },
    };
  }

  /**
   * Создает пагинированный ответ
   */
  static paginated<T>(
    items: T[],
    total: number,
    page: number,
    limit: number
  ): PaginatedResponse<T> {
    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }
}