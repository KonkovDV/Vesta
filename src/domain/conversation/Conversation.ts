/**
 * Агрегат Conversation - корень агрегата для бесед
 * Layer: Domain (бизнес-логика)
 * 
 * Инкапсулирует бизнес-правила и логику работы с беседами.
 * Является транзакционной границей - все изменения происходят через его методы.
 * 
 * Принципы DDD:
 * - Aggregate Root - единственная точка входа для изменений
 * - Генерирует доменные события при изменении состояния
 * - Обеспечивает инварианты (правила консистентности)
 * - Не зависит от инфраструктуры (БД, API и т.д.)
 */

import { AggregateRoot, DomainEvent } from '../../core/domain/AggregateRoot';
import { Timestamp, now } from '../../core/types';
import { ConversationId } from './ConversationId';
import { MessageId } from './MessageId';
import { ParticipantId } from './ParticipantId';
import {
  ConversationCreatedEvent,
  ConversationCreatedPayload,
  MessageAddedEvent,
  MessageAddedPayload,
  ParticipantAddedEvent,
  ParticipantAddedPayload,
  ParticipantRemovedEvent,
  ParticipantRemovedPayload,
  ConversationArchivedEvent,
  ConversationArchivedPayload,
  createConversationCreatedEvent,
  createMessageAddedEvent,
  createParticipantAddedEvent,
  createParticipantRemovedEvent,
  createConversationArchivedEvent,
  ConversationDomainEvent,
} from './events';

// ============================================================================
// Value Objects для Conversation
// ============================================================================

/**
 * Message - сообщение в беседе
 * Value Object, представляющий одно сообщение
 */
export interface Message {
  /** Уникальный ID сообщения */
  id: MessageId;
  /** Содержимое сообщения */
  content: string;
  /** ID автора */
  authorId: ParticipantId;
  /** Временная метка создания */
  createdAt: Timestamp;
  /** Тип сообщения */
  messageType: 'text' | 'image' | 'file' | 'system';
  /** ID родительского сообщения (для ответов) */
  parentMessageId?: MessageId;
  /** Метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Participant - участник беседы
 * Value Object, представляющий участника
 */
export interface Participant {
  /** ID участника */
  id: ParticipantId;
  /** Роль участника */
  role: 'member' | 'admin' | 'observer';
  /** Временная метка присоединения */
  joinedAt: Timestamp;
}

/**
 * ConversationStatus - статус беседы
 */
export type ConversationStatus = 'active' | 'archived' | 'deleted';

// ============================================================================
// Свойства агрегата
// ============================================================================

/**
 * Свойства агрегата Conversation
 * Содержит все данные о беседе
 */
export interface ConversationProps {
  /** ID создателя беседы */
  createdBy: string;
  /** Заголовок беседы */
  title?: string;
  /** Временная метка создания */
  createdAt: Timestamp;
  /** Список сообщений */
  messages: Message[];
  /** Список участников */
  participants: Participant[];
  /** Статус беседы */
  status: ConversationStatus;
  /** Временная метка последнего обновления */
  updatedAt: Timestamp;
  /** Метаданные */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Агрегат Conversation
// ============================================================================

/**
 * Conversation - агрегат беседы
 * 
 * Инкапсулирует всю бизнес-логику работы с беседами:
 * - Создание беседы
 * - Добавление сообщений
 * - Управление участниками
 * - Архивирование
 * 
 * @example
 * ```typescript
 * // Создание новой беседы
 * const conversation = Conversation.create({
 *   createdBy: 'user_123',
 *   title: 'Обсуждение проекта'
 * });
 * 
 * // Добавление сообщения
 * conversation.addMessage({
 *   content: 'Привет всем!',
 *   authorId: 'user_123'
 * });
 * 
 * // Получение доменных событий
 * const events = conversation.getEvents();
 * ```
 */
export class Conversation extends AggregateRoot<ConversationProps> {
  // Максимальное количество сообщений в беседе (бизнес-правило)
  private static readonly MAX_MESSAGES = 10000;
  // Максимальное количество участников (бизнес-правило)
  private static readonly MAX_PARTICIPANTS = 1000;

  /**
   * Приватный конструктор - используйте фабричные методы
   */
  private constructor(
    id: ConversationId,
    props: ConversationProps,
    version: number = 1
  ) {
    super(id, props, version);
  }

  /**
   * Создать новую беседу
   * 
   * @param params - Параметры создания
   * @returns Новый агрегат Conversation
   * 
   * @example
   * ```typescript
   * const conversation = Conversation.create({
   *   createdBy: 'user_123',
   *   title: 'Новая беседа',
   *   participantIds: ['user_123', 'user_456']
   * });
   * ```
   */
  static create(params: {
    createdBy: string;
    title?: string;
    participantIds?: string[];
    metadata?: Record<string, unknown>;
    correlationId?: string;
  }): Conversation {
    const id = ConversationId.create();
    const timestamp = now();
    const creatorId = ParticipantId.fromString(params.createdBy);

    // Создаем начальных участников
    const participants: Participant[] = [];
    
    // Создатель всегда администратор
    participants.push({
      id: creatorId,
      role: 'admin',
      joinedAt: timestamp,
    });

    // Добавляем остальных участников как members
    if (params.participantIds) {
      params.participantIds
        .filter(pid => pid !== params.createdBy) // Избегаем дубликатов
        .forEach(participantId => {
          participants.push({
            id: ParticipantId.fromString(participantId),
            role: 'member',
            joinedAt: timestamp,
          });
        });
    }

    const props: ConversationProps = {
      createdBy: params.createdBy,
      title: params.title,
      createdAt: timestamp,
      messages: [],
      participants,
      status: 'active',
      updatedAt: timestamp,
      metadata: params.metadata,
    };

    const conversation = new Conversation(id, props);

    // Генерируем событие ConversationCreated
    const event = createConversationCreatedEvent(
      id.toValue(),
      conversation.version,
      {
        createdBy: params.createdBy,
        title: params.title,
        createdAt: timestamp.toString(),
        participantIds: params.participantIds,
        metadata: params.metadata,
      },
      params.correlationId
    );

    conversation.addEvent(event);
    conversation.applyEvent(event);

    return conversation;
  }

  /**
   * Восстановить агрегат из сохраненного состояния
   * 
   * @param id - ID беседы
   * @param props - Сохраненные свойства
   * @param version - Версия агрегата
   * @returns Восстановленный агрегат
   */
  static restore(
    id: ConversationId,
    props: ConversationProps,
    version: number
  ): Conversation {
    return new Conversation(id, props, version);
  }

  /**
   * Добавить сообщение в беседу
   * 
   * Бизнес-правила:
   * - Беседа должна быть активна
   * - Автор должен быть участником
   * - Не превышен лимит сообщений
   * - Содержимое не пустое
   * 
   * @param params - Параметры сообщения
   * @throws Error если нарушены бизнес-правила
   * 
   * @example
   * ```typescript
   * conversation.addMessage({
   *   content: 'Привет!',
   *   authorId: 'user_123',
   *   messageType: 'text'
   * });
   * ```
   */
  addMessage(params: {
    content: string;
    authorId: string;
    messageType?: 'text' | 'image' | 'file' | 'system';
    parentMessageId?: string;
    metadata?: Record<string, unknown>;
    correlationId?: string;
  }): void {
    // Проверка инвариантов
    this.ensureActive();
    this.ensureParticipant(params.authorId);
    this.ensureNotMaxMessages();
    this.ensureValidContent(params.content);

    const messageId = MessageId.create();
    const timestamp = now();
    const authorParticipantId = ParticipantId.fromString(params.authorId);

    const message: Message = {
      id: messageId,
      content: params.content,
      authorId: authorParticipantId,
      createdAt: timestamp,
      messageType: params.messageType || 'text',
      parentMessageId: params.parentMessageId ? MessageId.fromString(params.parentMessageId) : undefined,
      metadata: params.metadata,
    };

    // Генерируем событие MessageAdded
    const event = createMessageAddedEvent(
      this.id.toValue(),
      this.version,
      {
        messageId: messageId.toValue(),
        content: params.content,
        authorId: params.authorId,
        createdAt: timestamp.toString(),
        messageType: message.messageType,
        parentMessageId: params.parentMessageId,
        metadata: params.metadata,
      },
      params.correlationId
    );

    this.addEvent(event);
    this.applyEvent(event);
  }

  /**
   * Добавить участника в беседу
   *
   * Бизнес-правила:
   * - Беседа должна быть активна
   * - Добавляющий должен быть администратором
   * - Не превышен лимит участников
   * - Участник не должен уже присутствовать в беседе
   *
   * @param params - Параметры участника
   * @throws Error если нарушены бизнес-правила
   *
   * @example
   * ```typescript
   * conversation.addParticipant({
   *   participantId: 'user_789',
   *   addedBy: 'admin_123',
   *   role: 'member'
   * });
   * ```
   */
  addParticipant(params: {
    participantId: string;
    addedBy: string;
    role?: 'member' | 'admin' | 'observer';
    correlationId?: string;
  }): void {
    // Проверка инвариантов
    this.ensureActive();
    this.ensureAdmin(params.addedBy);
    this.ensureNotMaxParticipants();
    this.ensureNotParticipant(params.participantId);

    const timestamp = now();
    const participantId = ParticipantId.fromString(params.participantId);
    const participant: Participant = {
      id: participantId,
      role: params.role || 'member',
      joinedAt: timestamp,
    };

    // Генерируем событие ParticipantAdded
    const event = createParticipantAddedEvent(
      this.id.toValue(),
      this.version,
      {
        participantId: params.participantId,
        addedBy: params.addedBy,
        addedAt: timestamp.toString(),
        role: participant.role,
      },
      params.correlationId
    );

    this.addEvent(event);
    this.applyEvent(event);
  }

  /**
   * Архивировать беседу
   * 
   * @param archivedBy - ID пользователя, который архивирует
   * @param reason - Причина архивирования
   * @throws Error если нарушены бизнес-правила
   */
  archive(archivedBy: string, reason?: string, correlationId?: string): void {
    this.ensureActive();
    this.ensureAdmin(archivedBy);

    const timestamp = now();

    // Генерируем событие ConversationArchived через фабрику
    const event = createConversationArchivedEvent(
      this.id.toValue(),
      this.version,
      {
        archivedBy,
        archivedAt: timestamp.toString(),
        reason,
      },
      correlationId
    );

    this.addEvent(event);
    this.applyEvent(event);
  }

  // ============================================================================
  // Геттеры для чтения состояния
  // ============================================================================

  get conversationId(): ConversationId {
    return this.id;
  }

  get messages(): readonly Message[] {
    return [...this.props.messages];
  }

  get participants(): readonly Participant[] {
    return [...this.props.participants];
  }

  get status(): ConversationStatus {
    return this.props.status;
  }

  get title(): string | undefined {
    return this.props.title;
  }

  get createdBy(): string {
    return this.props.createdBy;
  }

  get createdAt(): Timestamp {
    return this.props.createdAt;
  }

  get updatedAt(): Timestamp {
    return this.props.updatedAt;
  }

  get metadata(): Record<string, unknown> | undefined {
    return this.props.metadata;
  }

  get messageCount(): number {
    return this.props.messages.length;
  }

  get participantCount(): number {
    return this.props.participants.length;
  }

  // ============================================================================
  // Применение доменных событий (Event Sourcing)
  // ============================================================================

  protected when(event: DomainEvent): void {
    const conversationEvent = event as ConversationDomainEvent;

    switch (conversationEvent.type) {
      case 'ConversationCreated':
        this.whenConversationCreated(conversationEvent);
        break;
      case 'MessageAdded':
        this.whenMessageAdded(conversationEvent);
        break;
      case 'ParticipantAdded':
        this.whenParticipantAdded(conversationEvent);
        break;
      case 'ParticipantRemoved':
        this.whenParticipantRemoved(conversationEvent);
        break;
      case 'ConversationArchived':
        this.whenConversationArchived(conversationEvent);
        break;
      default:
        // Неизвестный тип события (теоретически недостижимо при полном покрытии union)
        throw new Error('Unknown event type in aggregate');
    }
  }

  private whenConversationCreated(event: ConversationCreatedEvent): void {
    // Событие создания уже применено в конструкторе
    // Здесь просто для полноты Event Sourcing паттерна
  }

  private whenMessageAdded(event: MessageAddedEvent): void {
    const message: Message = {
      id: MessageId.fromString(event.payload.messageId),
      content: event.payload.content,
      authorId: ParticipantId.fromString(event.payload.authorId),
      createdAt: Timestamp.fromString(event.payload.createdAt),
      messageType: event.payload.messageType || 'text',
      parentMessageId: event.payload.parentMessageId ? MessageId.fromString(event.payload.parentMessageId) : undefined,
      metadata: event.payload.metadata,
    };

    // Immutable update через setProps - создаем новый объект props
    this.setProps({
      ...this.props,
      messages: [...this.props.messages, message],
      updatedAt: now(),
    });
  }

  private whenParticipantAdded(event: ParticipantAddedEvent): void {
    const participant: Participant = {
      id: ParticipantId.fromString(event.payload.participantId),
      role: event.payload.role || 'member',
      joinedAt: Timestamp.fromString(event.payload.addedAt),
    };

    // Immutable update через setProps - создаем новый объект props
    this.setProps({
      ...this.props,
      participants: [...this.props.participants, participant],
      updatedAt: now(),
    });
  }

  private whenParticipantRemoved(event: ParticipantRemovedEvent): void {
    const removedParticipantId = ParticipantId.fromString(event.payload.participantId);
    
    // Immutable update через setProps - создаем новый объект props
    this.setProps({
      ...this.props,
      participants: this.props.participants.filter(
        p => !p.id.equals(removedParticipantId)
      ),
      updatedAt: now(),
    });
  }

  private whenConversationArchived(event: ConversationArchivedEvent): void {
    // Immutable update через setProps - создаем новый объект props
    this.setProps({
      ...this.props,
      status: 'archived' as const,
      updatedAt: now(),
    });
  }

  // ============================================================================
  // Проверка инвариантов (бизнес-правил)
  // ============================================================================

  private ensureActive(): void {
    if (this.props.status !== 'active') {
      throw new Error(`Conversation is not active. Current status: ${this.props.status}`);
    }
  }

  private ensureParticipant(userId: string): void {
    const participantId = ParticipantId.fromString(userId);
    const isParticipant = this.props.participants.some(p => p.id.equals(participantId));
    if (!isParticipant) {
      throw new Error(`User ${userId} is not a participant of the conversation`);
    }
  }

  private ensureNotParticipant(userId: string): void {
    const participantId = ParticipantId.fromString(userId);
    const isParticipant = this.props.participants.some(p => p.id.equals(participantId));
    if (isParticipant) {
      throw new Error(`User ${userId} is already a participant of the conversation`);
    }
  }

  private ensureAdmin(userId: string): void {
    const participantId = ParticipantId.fromString(userId);
    const participant = this.props.participants.find(p => p.id.equals(participantId));
    if (!participant || participant.role !== 'admin') {
      throw new Error(`User ${userId} is not an admin of the conversation`);
    }
  }

  private ensureNotMaxMessages(): void {
    if (this.props.messages.length >= Conversation.MAX_MESSAGES) {
      throw new Error(`Message limit reached: ${Conversation.MAX_MESSAGES}`);
    }
  }

  private ensureNotMaxParticipants(): void {
    if (this.props.participants.length >= Conversation.MAX_PARTICIPANTS) {
      throw new Error(`Participant limit reached: ${Conversation.MAX_PARTICIPANTS}`);
    }
  }

  private ensureValidContent(content: string): void {
    if (!content || content.trim().length === 0) {
      throw new Error('Message content cannot be empty');
    }
    if (content.length > 10000) {
      throw new Error('Message is too long (maximum 10000 characters)');
    }
  }

  // ============================================================================
  // Утилиты
  // ============================================================================
  
  // updateProps переопределять не нужно - используем setProps напрямую в when* методах

  serialize(): Record<string, unknown> {
    return {
      id: this.id.toValue(),
      version: this.version,
      createdBy: this.props.createdBy,
      title: this.props.title,
      createdAt: this.props.createdAt.toString(),
      messages: this.props.messages.map(m => ({
        id: m.id.toValue(),
        content: m.content,
        authorId: m.authorId.toValue(),
        createdAt: m.createdAt.toString(),
        messageType: m.messageType,
        parentMessageId: m.parentMessageId?.toValue(),
        metadata: m.metadata,
      })),
      participants: this.props.participants.map(p => ({
        id: p.id.toValue(),
        role: p.role,
        joinedAt: p.joinedAt.toString(),
      })),
      status: this.props.status,
      updatedAt: this.props.updatedAt.toString(),
      metadata: this.props.metadata,
    };
  }
}