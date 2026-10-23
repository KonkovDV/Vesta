/**
 * IUnitOfWork - интерфейс для Unit of Work паттерна
 * Layer: Domain (бизнес-логика)
 * 
 * Unit of Work управляет транзакциями и отслеживает изменения объектов.
 * Обеспечивает атомарность операций и консистентность данных.
 * 
 * Принципы:
 * - Интерфейс определяется в Domain слое
 * - Реализация в Infrastructure слое (PostgreSQL, Redis, etc.)
 * - Управляет транзакционными границами
 * - Отслеживает измененные объекты
 * 
 * @example
 * ```typescript
 * // Application Layer использует интерфейс
 * class CreateConversationUseCase {
 *   constructor(private unitOfWork: IUnitOfWork) {}
 *   
 *   async execute(command: CreateConversationCommand) {
 *     return await this.unitOfWork.executeInTransaction(async (transaction) => {
 *       const conversation = Conversation.create(command);
 *       await this.conversationRepo.save(conversation);
 *       await this.eventBus.publish(conversation.getEvents());
 *       return conversation.id;
 *     });
 *   }
 * }
 * ```
 */

import { DomainEvent } from '../events/event-store.interface';

/**
 * Статус транзакции
 */
export type TransactionStatus = 'pending' | 'active' | 'committed' | 'rolled_back' | 'failed';

/**
 * Стратегия вложенности транзакций
 */
export type TransactionNestingStrategy = 'SUPPORTED' | 'NEVER';

/**
 * Опции транзакции
 */
export interface TransactionOptions {
  /** Стратегия вложенности */
  nestingStrategy?: TransactionNestingStrategy;
  /** Изоляция транзакции */
  isolationLevel?: 'read_uncommitted' | 'read_committed' | 'repeatable_read' | 'serializable';
  /** Таймаут в миллисекундах */
  timeoutMs?: number;
  /** Повторные попытки при deadlock */
  retryOnDeadlock?: boolean;
  /** Максимальное количество попыток */
  maxRetryAttempts?: number;
  /** Abort signal для отмены транзакции (A-016) */
  signal?: AbortSignal;
}

/**
 * Информация о транзакции
 */
export interface TransactionInfo {
  /** ID транзакции */
  transactionId: string;
  /** Статус транзакции */
  status: TransactionStatus;
  /** Время начала */
  startedAt: Date;
  /** Время завершения */
  completedAt?: Date;
  /** Количество измененных объектов */
  modifiedObjectsCount: number;
  /** Количество опубликованных событий */
  publishedEventsCount: number;
}

/**
 * ITransaction - интерфейс для транзакции
 * 
 * @example
 * ```typescript
 * const transaction = await unitOfWork.begin();
 * try {
 *   await repository.save(entity);
 *   await transaction.commit();
 * } catch (error) {
 *   await transaction.rollback();
 * }
 * ```
 */
export interface ITransaction {
  /** ID транзакции */
  readonly transactionId: string;
  /** Статус транзакции */
  readonly status: TransactionStatus;
  /** Время начала */
  readonly startedAt: Date;
  /** Время завершения */
  readonly completedAt?: Date;

  /**
   * Зафиксировать транзакцию
   * 
   * @returns Promise<void>
   * @throws Error если транзакция уже завершена
   */
  commit(): Promise<void>;

  /**
   * Откатить транзакцию
   * 
   * @returns Promise<void>
   * @throws Error если транзакция уже завершена
   */
  rollback(): Promise<void>;

  /**
   * Получить информацию о транзакции
   * 
   * @returns Информация о транзакции
   */
  getInfo(): TransactionInfo;
}

/**
 * IUnitOfWork - интерфейс для Unit of Work
 * 
 * Управляет транзакциями и отслеживает изменения объектов.
 * Обеспечивает атомарность операций и консистентность данных.
 * 
 * @example
 * ```typescript
 * // Ручное управление транзакцией
 * const transaction = await unitOfWork.begin();
 * try {
 *   await repository.save(entity);
 *   await eventBus.publish(events);
 *   await transaction.commit();
 * } catch (error) {
 *   await transaction.rollback();
 *   throw error;
 * }
 * 
 * // Автоматическое управление
 * const result = await unitOfWork.executeInTransaction(async (tx) => {
 *   const entity = await repository.findById(id);
 *   entity.update(data);
 *   await repository.save(entity);
 *   return entity;
 * });
 * ```
 */
export interface IUnitOfWork {
  /**
   * Начать новую транзакцию
   * 
   * @param options - Опции транзакции
   * @returns Новая транзакция
   * 
   * @example
   * ```typescript
   * const transaction = await unitOfWork.begin({
   *   isolationLevel: 'read_committed',
   *   timeoutMs: 30000
   * });
   * ```
   */
  begin(options?: TransactionOptions): Promise<ITransaction>;

  /**
   * Выполнить операцию в транзакции
   * 
   * @param operation - Операция для выполнения
   * @param options - Опции транзакции
   * @returns Результат операции
   * 
   * @example
   * ```typescript
   * const result = await unitOfWork.executeInTransaction(
   *   async (transaction) => {
   *     const entity = await repository.findById(id);
   *     entity.update(data);
   *     await repository.save(entity);
   *     await eventBus.publish(entity.getEvents());
   *     return entity;
   *   },
   *   { isolationLevel: 'read_committed' }
   * );
   * ```
   */
  executeInTransaction<T>(
    operation: (transaction: ITransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;

  /**
   * Получить активную транзакцию (если есть)
   * 
   * @returns Активная транзакция или null
   * 
   * @example
   * ```typescript
   * const transaction = unitOfWork.getCurrentTransaction();
   * if (transaction) {
   *   // Есть активная транзакция
   * }
   * ```
   */
  getCurrentTransaction(): ITransaction | null;

  /**
   * Зарегистрировать измененный объект
   * 
   * @param object - Измененный объект
   * @param events - События объекта
   * 
   * @example
   * ```typescript
   * unitOfWork.registerChanged(conversation, conversation.getEvents());
   * ```
   */
  registerChanged(object: { id: { toString(): string } }, events: DomainEvent[]): void;

  /**
   * Зарегистрировать новый объект
   * 
   * @param object - Новый объект
   * @param events - События объекта
   * 
   * @example
   * ```typescript
   * unitOfWork.registerNew(conversation, conversation.getEvents());
   * ```
   */
  registerNew(object: { id: { toString(): string } }, events: DomainEvent[]): void;

  /**
   * Зарегистрировать удаленный объект
   * 
   * @param object - Удаленный объект
   * @param events - События объекта
   * 
   * @example
   * ```typescript
   * unitOfWork.registerDeleted(conversation, conversation.getEvents());
   * ```
   */
  registerDeleted(object: { id: { toString(): string } }, events: DomainEvent[]): void;

  /**
   * Получить все измененные объекты
   * 
   * @returns Массив измененных объектов
   * 
   * @example
   * ```typescript
   * const changed = unitOfWork.getChangedObjects();
   * ```
   */
  getChangedObjects(): Array<{ object: { id: { toString(): string } }; events: DomainEvent[] }>;

  /**
   * Очистить отслеживание изменений
   * 
   * @example
   * ```typescript
   * unitOfWork.clear();
   * ```
   */
  clear(): void;

  /**
   * Проверить здоровье Unit of Work
   * 
   * @returns true если здоров
   * 
   * @example
   * ```typescript
   * if (await unitOfWork.isHealthy()) {
   *   // Unit of Work работает
   * }
   * ```
   */
  isHealthy(): Promise<boolean>;

  /**
   * Закрыть Unit of Work
   * 
   * @example
   * ```typescript
   * await unitOfWork.close();
   * ```
   */
  close(): Promise<void>;
}