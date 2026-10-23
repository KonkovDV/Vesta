/**
 * IConversationRepository - интерфейс репозитория для агрегата Conversation
 * Layer: Domain (бизнес-логика)
 * 
 * Определяет контракт для сохранения и загрузки агрегатов Conversation.
 * Следует принципу Dependency Inversion - Domain не зависит от Infrastructure.
 * 
 * Принципы:
 * - Интерфейс определяется в Domain слое
 * - Реализация будет в Infrastructure слое
 * - Обеспечивает persistence ignorance (незнание о деталях хранения)
 * - Работает с доменными типами, а не с DTO
 */

import { Conversation, type Message } from './Conversation';
import { ConversationId } from './ConversationId';
import { ParticipantId } from './ParticipantId';

/**
 * Результат операции репозитория
 */
export type RepositoryResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: RepositoryError;
};

/**
 * Типы ошибок репозитория
 */
export enum RepositoryErrorType {
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Ошибка репозитория
 */
export class RepositoryError extends Error {
  constructor(
    public readonly type: RepositoryErrorType,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RepositoryError';
  }

  static notFound(id: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.NOT_FOUND,
      `Беседа с ID ${id} не найдена`,
      cause
    );
  }

  static conflict(id: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.CONFLICT,
      `Конфликт версий для беседы ${id}. Возможно, она была изменена другим процессом`,
      cause
    );
  }

  static connectionError(message: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.CONNECTION_ERROR,
      `Ошибка подключения к хранилищу: ${message}`,
      cause
    );
  }

  static validationError(message: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.VALIDATION_ERROR,
      `Ошибка валидации данных: ${message}`,
      cause
    );
  }

  static unknown(message: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.UNKNOWN_ERROR,
      message,
      cause
    );
  }
}

/**
 * Опции для поиска бесед
 */
export interface FindConversationsOptions {
  /** Фильтр по участнику */
  participantId?: string;
  /** Фильтр по создателю */
  createdBy?: string;
  /** Фильтр по статусу */
  status?: 'active' | 'archived' | 'deleted';
  /** Лимит результатов */
  limit?: number;
  /** Смещение для пагинации */
  offset?: number;
  /** Сортировка */
  sortBy?: 'createdAt' | 'updatedAt';
  /** Порядок сортировки */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Результат поиска бесед с пагинацией
 */
export interface ConversationSearchResult {
  /** Найденные беседы */
  conversations: Conversation[];
  /** Общее количество (для пагинации) */
  total: number;
  /** Количество возвращенных результатов */
  count: number;
  /** Смещение */
  offset: number;
  /** Лимит */
  limit: number;
}

/**
 * IConversationRepository - интерфейс для работы с агрегатами Conversation
 * 
 * Определяет операции для persistence агрегатов без привязки к конкретной технологии хранения.
 * 
 * Реализация этого интерфейса будет в Infrastructure слое и может использовать:
 * - SQL базы данных (PostgreSQL, MySQL)
 * - NoSQL базы данных (MongoDB, DynamoDB)
 * - Event Store для Event Sourcing
 * - In-memory хранилище для тестов
 * 
 * @example
 * ```typescript
 * // Application Layer использует интерфейс
 * class SendMessageHandler {
 *   constructor(private repo: IConversationRepository) {}
 *   
 *   async execute(command: SendMessageCommand) {
 *     const result = await this.repo.findById(command.conversationId);
 *     if (!result.success) {
 *       throw result.error;
 *     }
 *     
 *     const conversation = result.data;
 *     conversation.addMessage({
 *       content: command.content,
 *       authorId: command.authorId
 *     });
 *     
 *     await this.repo.save(conversation);
 *   }
 * }
 * ```
 */
export interface IConversationRepository {
  /**
   * Найти беседу по ID
   * 
   * @param id - ID беседы
   * @returns Result с агрегатом или ошибкой
   * 
   * @example
   * ```typescript
   * const result = await repository.findById(conversationId);
   * if (result.success) {
   *   const conversation = result.data;
   *   // Работаем с беседой
   * } else {
   *   // Обрабатываем ошибку
   *   console.error(result.error);
   * }
   * ```
   */
  findById(id: ConversationId): Promise<RepositoryResult<Conversation>>;

  /**
   * Найти беседу по ID или вернуть null
   * Удобная альтернатива findById для случаев, когда отсутствие - не ошибка
   * 
   * @param id - ID беседы
   * @returns Агрегат или null если не найден
   * @throws RepositoryError при других ошибках (не NOT_FOUND)
   * 
   * @example
   * ```typescript
   * const conversation = await repository.findByIdOrNull(conversationId);
   * if (conversation) {
   *   // Беседа найдена
   * } else {
   *   // Беседа не найдена - создаем новую
   * }
   * ```
   */
  findByIdOrNull(id: ConversationId): Promise<Conversation | null>;

  /**
   * Найти беседы по критериям
   * 
   * @param options - Опции поиска и фильтрации
   * @returns Result с результатами поиска
   * 
   * @example
   * ```typescript
   * const result = await repository.find({
   *   participantId: 'user_123',
   *   status: 'active',
   *   limit: 20,
   *   sortBy: 'updatedAt',
   *   sortOrder: 'desc'
   * });
   * ```
   */
  find(options: FindConversationsOptions): Promise<RepositoryResult<ConversationSearchResult>>;

  /**
   * Сохранить агрегат
   * 
   * Сохраняет изменения агрегата и его доменные события в рамках транзакции.
   * Реализация должна:
   * 1. Проверить версию агрегата (optimistic locking)
   * 2. Сохранить состояние агрегата
   * 3. Сохранить доменные события в Outbox
   * 4. Очистить список событий агрегата
   * 
   * @param conversation - Агрегат для сохранения
   * @returns Result с сохраненным агрегатом или ошибкой
   * @throws RepositoryError.CONFLICT при конфликте версий
   * 
   * @example
   * ```typescript
   * conversation.addMessage({ content: 'Hello', authorId: 'user_123' });
   * const result = await repository.save(conversation);
   * if (result.success) {
   *   console.log('Сохранено успешно');
   * }
   * ```
   */
  save(conversation: Conversation): Promise<RepositoryResult<Conversation>>;

  /**
   * Удалить беседу (soft delete)
   * 
   * Помечает беседу как удаленную, но не удаляет физически.
   * Это сохраняет историю для аудита.
   * 
   * @param id - ID беседы
   * @returns Result с успехом или ошибкой
   * 
   * @example
   * ```typescript
   * const result = await repository.delete(conversationId);
   * ```
   */
  delete(id: ConversationId): Promise<RepositoryResult<void>>;

  /**
   * Проверить существование беседы
   * 
   * @param id - ID беседы
   * @returns true если беседа существует
   * 
   * @example
   * ```typescript
   * if (await repository.exists(conversationId)) {
   *   // Беседа существует
   * }
   * ```
   */
  exists(id: ConversationId): Promise<boolean>;

  /**
   * Подсчитать количество бесед по критериям
   *
   * @param options - Опции фильтрации (без пагинации)
   * @returns Количество бесед
   *
   * @example
   * ```typescript
   * const activeCount = await repository.count({ status: 'active' });
   * ```
   */
  count(options?: Omit<FindConversationsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number>;
  
  /**
   * Получить историю сообщений для беседы.
   *
   * @param id - ID беседы
   * @param options - Опции истории (лимит и смещение)
   */
  getMessageHistory(
    id: ConversationId,
    options?: {
      /** Максимальное количество сообщений в ответе */
      limit?: number;
      /** Смещение от конца истории (0 = самые последние сообщения) */
      offset?: number;
    },
  ): Promise<RepositoryResult<ReadonlyArray<Message>>>;
  
  /**
   * Восстановить агрегат из Event Store (для Event Sourcing)
   *
   * Опциональный метод для реализаций, использующих Event Sourcing.
   * Восстанавливает состояние агрегата путем последовательного применения событий.
   *
   * @param id - ID беседы
   * @returns Result с восстановленным агрегатом
   *
   * @example
   * ```typescript
   * const result = await repository.rehydrate(conversationId);
   * if (result.success) {
   *   const conversation = result.data;
   *   // Агрегат восстановлен из событий
   * }
   * ```
   */
  rehydrate?(id: ConversationId): Promise<RepositoryResult<Conversation>>;
}

/**
 * Базовая реализация In-Memory репозитория для тестов
 * 
 * Используется в unit-тестах для изоляции Domain логики от Infrastructure.
 * НЕ ИСПОЛЬЗОВАТЬ в production!
 * 
 * @example
 * ```typescript
 * const repository = new InMemoryConversationRepository();
 * const conversation = Conversation.create({ createdBy: 'user_123' });
 * await repository.save(conversation);
 * ```
 */
export class InMemoryConversationRepository implements IConversationRepository {
  private conversations = new Map<string, Conversation>();

  async findById(id: ConversationId): Promise<RepositoryResult<Conversation>> {
    const conversation = this.conversations.get(id.toValue());
    if (!conversation) {
      return {
        success: false,
        error: RepositoryError.notFound(id.toValue()),
      };
    }
    return { success: true, data: conversation };
  }

  async findByIdOrNull(id: ConversationId): Promise<Conversation | null> {
    return this.conversations.get(id.toValue()) || null;
  }

  async find(options: FindConversationsOptions): Promise<RepositoryResult<ConversationSearchResult>> {
    let conversations = Array.from(this.conversations.values());

    // Применяем фильтры
    const participantIdFilter = options.participantId;
    if (participantIdFilter) {
      conversations = conversations.filter(c =>
        c.participants.some(p => {
          const participant = p as { id?: { equals?: (id: ParticipantId) => boolean; toString?: () => string } | string };
          const participantId = participant.id;
          if (!participantId) return false;
          
          if (typeof participantId === 'object' && 'equals' in participantId && typeof participantId.equals === 'function') {
            return participantId.equals(ParticipantId.fromString(participantIdFilter));
          }
          
          return participantId === participantIdFilter;
        })
      );
    }
    if (options.createdBy) {
      conversations = conversations.filter(c => c.createdBy === options.createdBy);
    }
    if (options.status) {
      conversations = conversations.filter(c => c.status === options.status);
    }

    // Сортировка
    const sortBy = options.sortBy || 'createdAt';
    const sortOrder = options.sortOrder || 'desc';
    conversations.sort((a, b) => {
      const aTime = sortBy === 'createdAt' ? a.createdAt.toDate() : a.updatedAt.toDate();
      const bTime = sortBy === 'createdAt' ? b.createdAt.toDate() : b.updatedAt.toDate();
      return sortOrder === 'asc' ? aTime.getTime() - bTime.getTime() : bTime.getTime() - aTime.getTime();
    });

    const total = conversations.length;
    const offset = options.offset || 0;
    const limit = options.limit || 10;

    // Пагинация
    conversations = conversations.slice(offset, offset + limit);

    return {
      success: true,
      data: {
        conversations,
        total,
        count: conversations.length,
        offset,
        limit,
      },
    };
  }

  async save(conversation: Conversation): Promise<RepositoryResult<Conversation>> {
    // Проверка версии для optimistic locking
    const existing = this.conversations.get(conversation.conversationId.toValue());
    if (existing && existing.version !== conversation.version - 1) {
      return {
        success: false,
        error: RepositoryError.conflict(conversation.conversationId.toValue()),
      };
    }

    // Очищаем события (они должны быть обработаны перед сохранением)
    conversation.clearEvents();

    // Сохраняем
    this.conversations.set(conversation.conversationId.toValue(), conversation);

    return { success: true, data: conversation };
  }

  async delete(id: ConversationId): Promise<RepositoryResult<void>> {
    const conversation = this.conversations.get(id.toValue());
    if (!conversation) {
      return {
        success: false,
        error: RepositoryError.notFound(id.toValue()),
      };
    }

    // Soft delete - помечаем как удаленную
    conversation.archive('system', 'Deleted');
    
    return { success: true, data: undefined };
  }

  async exists(id: ConversationId): Promise<boolean> {
    return this.conversations.has(id.toValue());
  }

  async count(options?: Omit<FindConversationsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number> {
    let conversations = Array.from(this.conversations.values());
 
    const participantIdFilter = options?.participantId;
    if (participantIdFilter) {
      conversations = conversations.filter(c =>
        c.participants.some(p => {
          const participant = p as { id?: { equals?: (id: ParticipantId) => boolean; toString?: () => string } | string };
          const participantId = participant.id;
          if (!participantId) return false;
          
          if (typeof participantId === 'object' && 'equals' in participantId && typeof participantId.equals === 'function') {
            return participantId.equals(ParticipantId.fromString(participantIdFilter));
          }
          
          return participantId === participantIdFilter;
        })
      );
    }
    if (options?.createdBy) {
      conversations = conversations.filter(c => c.createdBy === options.createdBy);
    }
    if (options?.status) {
      conversations = conversations.filter(c => c.status === options.status);
    }
 
    return conversations.length;
  }

  async getMessageHistory(
    id: ConversationId,
    options?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<RepositoryResult<ReadonlyArray<Message>>> {
    const conversation = this.conversations.get(id.toValue());

    if (!conversation) {
      return {
        success: false,
        error: RepositoryError.notFound(id.toValue()),
      };
    }

    const allMessages = conversation.messages;
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const safeLimit = limit > 0 ? limit : 0;
    const safeOffset = offset > 0 ? offset : 0;

    const totalCount = allMessages.length;

    const endIndexFromEnd = safeOffset;
    const startIndexFromEnd = safeOffset + safeLimit;

    const startIndex =
      startIndexFromEnd >= totalCount ? 0 : totalCount - startIndexFromEnd;
    const endIndex = totalCount - endIndexFromEnd;

    const boundedStart = startIndex < 0 ? 0 : startIndex;
    const boundedEnd = endIndex > totalCount ? totalCount : endIndex;

    const messages = allMessages.slice(boundedStart, boundedEnd);

    return {
      success: true,
      data: messages,
    };
  }
 
  // Утилиты для тестов
  clear(): void {
    this.conversations.clear();
  }

  getAll(): Conversation[] {
    return Array.from(this.conversations.values());
  }
}