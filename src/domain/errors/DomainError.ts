/**
 * DomainError - базовый класс для доменных ошибок
 * Layer: Domain (бизнес-логика)
 * 
 * Предоставляет типизированную систему ошибок для бизнес-правил.
 * Все доменные ошибки должны наследоваться от этого класса.
 * 
 * Принципы:
 * - Явная типизация ошибок
 * - Бизнес-контекст в ошибках
 * - Поддержка иерархии ошибок
 * - Интеграция с мониторингом
 * 
 * @example
 * ```typescript
 * // Создание доменной ошибки
 * throw new ConversationNotFoundError('conv_123');
 * 
 * // Обработка доменных ошибок
 * try {
 *   await useCase.execute(command);
 * } catch (error) {
 *   if (error instanceof DomainError) {
 *     // Обработка по типу ошибки
 *     switch (error.code) {
 *       case 'CONVERSATION_NOT_FOUND':
 *         return { success: false, error: error.message };
 *       case 'VALIDATION_ERROR':
 *         return { success: false, error: error.details };
 *     }
 *   }
 * }
 * ```
 */

/**
 * Коды доменных ошибок
 */
export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'BUSINESS_RULE_VIOLATION'
  | 'ENTITY_NOT_FOUND'
  | 'ENTITY_ALREADY_EXISTS'
  | 'INVALID_STATE'
  | 'AUTHORIZATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'CONSTRAINT_VIOLATION'
  | 'DOMAIN_INVARIANT_VIOLATED'
  | 'AGGREGATE_NOT_FOUND'
  | 'AGGREGATE_CONFLICT'
  | 'DOMAIN_EVENT_ERROR'
  | 'REPOSITORY_ERROR'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'INFRASTRUCTURE_ERROR'
  | 'TIMEOUT_ERROR'
  | 'RATE_LIMIT_EXCEEDED'
  | 'RESOURCE_EXHAUSTED'
  | 'SECURITY_ERROR'
  | 'PYTHON_EXECUTION_ERROR'
  | 'TRANSACTION_CONTEXT_ERROR'
  | 'CONCURRENCY_ERROR'
  | 'CONFIGURATION_ERROR';

/**
 * Детали ошибки валидации
 */
export interface ValidationErrorDetail {
  field: string;
  message: string;
  value?: unknown;
  constraint?: string;
}

/**
 * Базовый класс для всех доменных ошибок
 */
export abstract class DomainError extends Error {
  /**
   * Код ошибки для идентификации типа
   */
  public readonly code: DomainErrorCode;

  /**
   * HTTP статус код (для Presentation Layer)
   */
  public readonly httpStatusCode: number;

  /**
   * Временная метка возникновения ошибки
   */
  public readonly timestamp: Date;

  /**
   * Correlation ID для трассировки
   */
  public readonly correlationId?: string;

  /**
   * Дополнительные данные ошибки
   */
  public readonly metadata?: Record<string, unknown>;

  /**
   * Исходная причина ошибки (chained error)
   */
  public readonly cause?: Error;

  constructor(
    message: string,
    code: DomainErrorCode,
    options?: {
      httpStatusCode?: number;
      correlationId?: string;
      metadata?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatusCode = options?.httpStatusCode ?? 500;
    this.timestamp = new Date();
    this.correlationId = options?.correlationId;
    this.metadata = options?.metadata;
    this.cause = options?.cause;

    // Сохраняем стек вызовов
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    // Добавляем stack trace исходной ошибки (cause chaining)
    if (this.cause && this.cause.stack && this.stack) {
      this.stack += `\nCaused by: ${this.cause.stack}`;
    }
  }

  /**
   * Преобразовать ошибку в объект для сериализации
   */
  toJSON(): {
    name: string;
    code: DomainErrorCode;
    message: string;
    httpStatusCode: number;
    timestamp: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
    stack?: string;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatusCode: this.httpStatusCode,
      timestamp: this.timestamp.toISOString(),
      correlationId: this.correlationId,
      metadata: this.metadata,
      // Stack traces are included in serialization; API boundary handlers (error middleware)
      // must strip them before sending to clients in production (OWASP Error Handling CS §3).
      // Domain layer must NOT access process.env (Hard Rule #11).
      ...(this.stack ? { stack: this.stack } : {}),
    };
  }

  /**
   * Проверить, является ли ошибка временной (можно повторить операцию)
   */
  isTransient(): boolean {
    return [
      'TIMEOUT_ERROR',
      'EXTERNAL_SERVICE_ERROR',
      'RATE_LIMIT_EXCEEDED',
      'RESOURCE_EXHAUSTED',
    ].includes(this.code);
  }

  /**
   * Проверить, является ли ошибка ошибкой валидации
   */
  isValidationError(): boolean {
    return this.code === 'VALIDATION_ERROR';
  }

  /**
   * Проверить, является ли ошибка ошибкой авторизации
   */
  isAuthorizationError(): boolean {
    return ['AUTHORIZATION_ERROR', 'PERMISSION_DENIED'].includes(this.code);
  }

  /**
   * Проверить, является ли ошибка ошибкой бизнес-правил
   */
  isBusinessRuleViolation(): boolean {
    return [
      'BUSINESS_RULE_VIOLATION',
      'INVALID_STATE',
      'CONSTRAINT_VIOLATION',
      'DOMAIN_INVARIANT_VIOLATED',
    ].includes(this.code);
  }
}

/**
 * Ошибка валидации
 */
export class ValidationError extends DomainError {
  public readonly details: ValidationErrorDetail[];

  constructor(
    message: string,
    details: ValidationErrorDetail[],
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      message,
      'VALIDATION_ERROR',
      {
        httpStatusCode: 400,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          details,
        },
      }
    );
    this.details = details;
  }

  /**
   * Создать ошибку валидации из Zod ошибки
   */
  static fromZodError(
    zodError: {
      issues?: ReadonlyArray<{ path?: readonly PropertyKey[]; message?: string; value?: unknown }>;
      errors?: ReadonlyArray<{ path?: readonly PropertyKey[]; message?: string; value?: unknown }>;
    },
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ): ValidationError {
    const issues = zodError.issues ?? zodError.errors;
    const details: ValidationErrorDetail[] = issues?.map((err) => ({
      field: err.path?.join('.') || 'unknown',
      message: err.message || 'Validation error',
      value: err.value,
    })) || [];

    return new ValidationError(
      'Validation failed',
      details,
      options
    );
  }
}

/**
 * Ошибка нарушения бизнес-правил
 */
export class BusinessRuleViolationError extends DomainError {
  constructor(
    message: string,
    rule: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      message,
      'BUSINESS_RULE_VIOLATION',
      {
        httpStatusCode: 422,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          rule,
        },
      }
    );
  }
}

/**
 * Ошибка: сущность не найдена
 */
export class EntityNotFoundError extends DomainError {
  constructor(
    entityType: string,
    entityId: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `${entityType} with ID ${entityId} not found`,
      'ENTITY_NOT_FOUND',
      {
        httpStatusCode: 404,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          entityType,
          entityId,
        },
      }
    );
  }
}

/**
 * Ошибка: сущность уже существует
 */
export class EntityAlreadyExistsError extends DomainError {
  constructor(
    entityType: string,
    identifier: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `${entityType} already exists: ${identifier}`,
      'ENTITY_ALREADY_EXISTS',
      {
        httpStatusCode: 409,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          entityType,
          identifier,
        },
      }
    );
  }
}

/**
 * Ошибка: недопустимое состояние
 */
export class InvalidStateError extends DomainError {
  constructor(
    entityType: string,
    currentState: string,
    expectedState: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `${entityType} is in invalid state: ${currentState}, expected: ${expectedState}`,
      'INVALID_STATE',
      {
        httpStatusCode: 422,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          entityType,
          currentState,
          expectedState,
        },
      }
    );
  }
}

/**
 * Ошибка авторизации
 */
export class AuthorizationError extends DomainError {
  constructor(
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      message,
      'AUTHORIZATION_ERROR',
      {
        httpStatusCode: 401,
        correlationId: options?.correlationId,
        metadata: options?.metadata,
      }
    );
  }
}

/**
 * Ошибка: доступ запрещен
 */
export class PermissionDeniedError extends DomainError {
  constructor(
    resource: string,
    action: string,
    userId?: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `Permission denied: ${action} on ${resource}` + (userId ? ` for user ${userId}` : ''),
      'PERMISSION_DENIED',
      {
        httpStatusCode: 403,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          resource,
          action,
          userId,
        },
      }
    );
  }
}

/**
 * Ошибка: нарушение ограничения
 */
export class ConstraintViolationError extends DomainError {
  constructor(
    constraint: string,
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      message,
      'CONSTRAINT_VIOLATION',
      {
        httpStatusCode: 422,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          constraint,
        },
      }
    );
  }
}

/**
 * Ошибка: нарушение инварианта домена
 */
export class DomainInvariantViolationError extends DomainError {
  constructor(
    invariant: string,
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      message,
      'DOMAIN_INVARIANT_VIOLATED',
      {
        httpStatusCode: 422,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          invariant,
        },
      }
    );
  }
}

/**
 * Ошибка: агрегат не найден
 */
export class AggregateNotFoundError extends DomainError {
  constructor(
    aggregateType: string,
    aggregateId: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `${aggregateType} aggregate with ID ${aggregateId} not found`,
      'AGGREGATE_NOT_FOUND',
      {
        httpStatusCode: 404,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          aggregateType,
          aggregateId,
        },
      }
    );
  }
}

/**
 * Ошибка: конфликт агрегата (оптимистичная блокировка)
 */
export class AggregateConflictError extends DomainError {
  constructor(
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    actualVersion: number,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `${aggregateType} aggregate ${aggregateId} version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
      'AGGREGATE_CONFLICT',
      {
        httpStatusCode: 409,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          aggregateType,
          aggregateId,
          expectedVersion,
          actualVersion,
        },
      }
    );
  }
}

/**
 * Ошибка: внешний сервис недоступен
 */
export class ExternalServiceError extends DomainError {
  constructor(
    serviceName: string,
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(
      `${serviceName} service error: ${message}`,
      'EXTERNAL_SERVICE_ERROR',
      {
        httpStatusCode: 503,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          serviceName,
        },
        cause: options?.cause,
      }
    );
  }
}

/**
 * Ошибка инфраструктуры (база данных, брокер сообщений и т.п.)
 */
export class InfrastructureError extends DomainError {
  constructor(
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(
      message,
      'INFRASTRUCTURE_ERROR',
      {
        httpStatusCode: 500,
        correlationId: options?.correlationId,
        metadata: options?.metadata,
        cause: options?.cause,
      }
    );
  }
}

/**
 * Ошибка конкурентного доступа (optimistic/pessimistic locking и т.п.)
 */
export class ConcurrencyError extends DomainError {
  constructor(
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(
      message,
      'CONCURRENCY_ERROR',
      {
        httpStatusCode: 409,
        correlationId: options?.correlationId,
        metadata: options?.metadata,
        cause: options?.cause,
      }
    );
  }
}

/**
 * Ошибка: таймаут операции
 */
export class TimeoutError extends DomainError {
  constructor(
    operation: string,
    timeoutMs: number,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `${operation} timeout after ${timeoutMs}ms`,
      'TIMEOUT_ERROR',
      {
        httpStatusCode: 504,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          operation,
          timeoutMs,
        },
      }
    );
  }
}

/**
 * Ошибка: превышен лимит запросов
 */
export class RateLimitExceededError extends DomainError {
  constructor(
    limit: number,
    windowMs: number,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `Rate limit exceeded: ${limit} requests per ${windowMs}ms`,
      'RATE_LIMIT_EXCEEDED',
      {
        httpStatusCode: 429,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          limit,
          windowMs,
        },
      }
    );
  }
}

/**
 * Ошибка: ресурс исчерпан
 */
export class ResourceExhaustedError extends DomainError {
  constructor(
    resource: string,
    limit: number,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      `Resource exhausted: ${resource} (limit: ${limit})`,
      'RESOURCE_EXHAUSTED',
      {
        httpStatusCode: 429,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          resource,
          limit,
        },
      }
    );
  }
}

/**
 * Ошибка безопасности (SecurityError)
 *
 * Используется для представления проблем безопасности:
 * - попытки Command Injection;
 * - path traversal;
 * - недопустимые значения аргументов/окружения.
 */
export class SecurityError extends DomainError {
  constructor(
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      message,
      'SECURITY_ERROR',
      {
        httpStatusCode: 400,
        correlationId: options?.correlationId,
        metadata: options?.metadata,
      }
    );
  }
}

/**
 * Ошибка контекста транзакции.
 *
 * Используется, когда код ожидает активный транзакционный контекст
 * (например, AsyncLocalStorage с клиентом БД), но он отсутствует.
 * Вместо тихого перехода в autocommit режим выбрасывается эта ошибка.
 */
export class TransactionContextError extends DomainError {
  constructor(
    message: string = 'No active transaction context',
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    super(
      message,
      'TRANSACTION_CONTEXT_ERROR',
      {
        httpStatusCode: 500,
        correlationId: options?.correlationId,
        metadata: options?.metadata,
      }
    );
  }
}

/**
 * Ошибка выполнения Python-скрипта.
 *
 * Оборачивает технические ошибки запуска Python-процесса в доменную форму.
 */
export class ConfigurationError extends DomainError {
  constructor(
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(
      message,
      'CONFIGURATION_ERROR',
      {
        httpStatusCode: 500,
        correlationId: options?.correlationId,
        metadata: options?.metadata,
        cause: options?.cause,
      }
    );
  }
}

export class PythonExecutionError extends DomainError {
  constructor(
    message: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(
      message,
      'PYTHON_EXECUTION_ERROR',
      {
        httpStatusCode: 502,
        correlationId: options?.correlationId,
        metadata: options?.metadata,
        cause: options?.cause,
      }
    );
  }
}

/**
 * Ошибка выполнения хука (hook handler failure).
 */
export class HookExecutionError extends DomainError {
  constructor(
    hookName: string,
    source: string,
    options?: {
      correlationId?: string;
      metadata?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(
      `Hook '${hookName}' failed in '${source}'`,
      'INFRASTRUCTURE_ERROR',
      {
        httpStatusCode: 500,
        correlationId: options?.correlationId,
        metadata: {
          ...options?.metadata,
          hookName,
          source,
        },
        cause: options?.cause,
      }
    );
  }
}

/**
 * Фабрика для создания доменных ошибок
 */
export class DomainErrorFactory {
  /**
   * Создать ошибку валидации
   */
  static validation(
    message: string,
    details: ValidationErrorDetail[],
    options?: { correlationId?: string; metadata?: Record<string, unknown> }
  ): ValidationError {
    return new ValidationError(message, details, options);
  }

  /**
   * Создать ошибку нарушения бизнес-правил
   */
  static businessRule(
    message: string,
    rule: string,
    options?: { correlationId?: string; metadata?: Record<string, unknown> }
  ): BusinessRuleViolationError {
    return new BusinessRuleViolationError(message, rule, options);
  }

  /**
   * Создать ошибку "не найдено"
   */
  static notFound(
    entityType: string,
    entityId: string,
    options?: { correlationId?: string; metadata?: Record<string, unknown> }
  ): EntityNotFoundError {
    return new EntityNotFoundError(entityType, entityId, options);
  }

  /**
   * Создать ошибку "уже существует"
   */
  static alreadyExists(
    entityType: string,
    identifier: string,
    options?: { correlationId?: string; metadata?: Record<string, unknown> }
  ): EntityAlreadyExistsError {
    return new EntityAlreadyExistsError(entityType, identifier, options);
  }

  /**
   * Создать ошибку недостаточно прав
   */
  static permissionDenied(
    resource: string,
    action: string,
    userId?: string,
    options?: { correlationId?: string; metadata?: Record<string, unknown> }
  ): PermissionDeniedError {
    return new PermissionDeniedError(resource, action, userId, options);
  }

  /**
   * Создать ошибку таймаута
   */
  static timeout(
    operation: string,
    timeoutMs: number,
    options?: { correlationId?: string; metadata?: Record<string, unknown> }
  ): TimeoutError {
    return new TimeoutError(operation, timeoutMs, options);
  }

  /**
   * Создать ошибку внешнего сервиса
   */
  static externalService(
    serviceName: string,
    message: string,
    options?: { correlationId?: string; metadata?: Record<string, unknown>; cause?: Error }
  ): ExternalServiceError {
    return new ExternalServiceError(serviceName, message, options);
  }
}