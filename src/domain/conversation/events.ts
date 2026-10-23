/**
 * Доменные события для агрегата Conversation
 * Layer: Domain (бизнес-логика)
 * 
 * События описывают важные факты, произошедшие в домене.
 * Они используются для Event Sourcing и интеграции между bounded contexts.
 * 
 * Принципы:
 * - События неизменяемы (immutable)
 * - Названия в прошедшем времени (что случилось)
 * - Содержат минимально необходимые данные
 * - Типобезопасны через TypeScript
 */

import { DomainEvent } from '../../core/domain/AggregateRoot';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { safeJsonParse } from '../../core/utils/json';

/**
 * Базовый интерфейс для всех событий Conversation.
 * Расширяет DomainEvent из Core и добавляет conversationId.
 *
 * Инварианты:
 * - aggregateId содержит каноническое значение ConversationId.toValue()
 *   (а не логгерное представление ConversationId.toString()).
 * - Ответственность за передачу канонического aggregateId лежит на вызывающем
 *   коде (агрегат, репозиторий и т.п.).
 */
interface ConversationEvent extends DomainEvent {
  /** Канонический ID беседы (ConversationId.toValue()), к которой относится событие */
  aggregateId: string;
  /** Correlation ID для трассировки цепочки операций */
  correlationId: string;
  /** Опциональный causation ID */
  causationId?: string;
}

// ============================================================================
// ConversationCreated - Событие создания новой беседы
// ============================================================================

/**
 * Payload для события ConversationCreated
 * Содержит данные о созданной беседе
 */
export interface ConversationCreatedPayload {
  /** ID создателя беседы */
  createdBy: string;
  /** Заголовок беседы (опционально) */
  title?: string;
  /** Временная метка создания */
  createdAt: string;
  /** Начальные участники беседы */
  participantIds?: string[];
  /** Метаданные беседы */
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * ConversationCreated - событие создания беседы
 * 
 * Генерируется при создании нового агрегата Conversation
 * 
 * @example
 * ```typescript
 * const event: ConversationCreatedEvent = {
 *   eventId: 'evt_abc123_1234567890_xyz',
 *   type: 'ConversationCreated',
 *   timestamp: new Date(),
 *   aggregateId: 'conv_abc123',
 *   aggregateVersion: 1,
 *   payload: {
 *     createdBy: 'user_123',
 *     title: 'Обсуждение проекта',
 *     createdAt: '2025-11-01T13:43:00.000Z',
 *     participantIds: ['user_123', 'user_456']
 *   }
 * };
 * ```
 */
export interface ConversationCreatedEvent extends ConversationEvent {
  type: 'ConversationCreated';
  payload: ConversationCreatedPayload;
}

/**
 * Фабрика для создания события ConversationCreated
 *
 * Контракт:
 * - aggregateId должен передаваться как каноническое значение ConversationId.toValue().
 *
 * @param aggregateId - Канонический ID беседы (ConversationId.toValue())
 * @param aggregateVersion - Версия агрегата
 * @param payload - Данные события
 * @returns Полностью сформированное событие
 */
export function createConversationCreatedEvent(
  aggregateId: string,
  aggregateVersion: number,
  payload: ConversationCreatedPayload,
  correlationId?: string,
  causationId?: string
): ConversationCreatedEvent {
  const corr = CorrelationIdProvider.isValid(correlationId)
    ? CorrelationIdProvider.normalize(correlationId)
    : CorrelationIdProvider.generate();
  return {
    eventId: generateEventId(aggregateId),
    type: 'ConversationCreated',
    timestamp: new Date(),
    aggregateId,
    aggregateVersion,
    correlationId: corr,
    causationId,
    payload,
  };
}

// ============================================================================
// MessageAdded - Событие добавления сообщения в беседу
// ============================================================================

/**
 * Payload для события MessageAdded
 * Содержит данные о добавленном сообщении
 */
export interface MessageAddedPayload {
  /** ID сообщения */
  messageId: string;
  /** Содержимое сообщения */
  content: string;
  /** ID автора сообщения */
  authorId: string;
  /** Временная метка создания сообщения */
  createdAt: string;
  /** Тип сообщения (text, image, file и т.д.) */
  messageType?: 'text' | 'image' | 'file' | 'system';
  /** ID родительского сообщения (для ответов) */
  parentMessageId?: string;
  /** Метаданные сообщения */
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * MessageAdded - событие добавления сообщения
 * 
 * Генерируется при вызове метода conversation.addMessage()
 * 
 * @example
 * ```typescript
 * const event: MessageAddedEvent = {
 *   eventId: 'evt_abc123_1234567891_xyz',
 *   type: 'MessageAdded',
 *   timestamp: new Date(),
 *   aggregateId: 'conv_abc123',
 *   aggregateVersion: 2,
 *   payload: {
 *     messageId: 'msg_xyz789',
 *     content: 'Привет, как дела?',
 *     authorId: 'user_123',
 *     createdAt: '2025-11-01T13:43:30.000Z',
 *     messageType: 'text'
 *   }
 * };
 * ```
 */
export interface MessageAddedEvent extends ConversationEvent {
  type: 'MessageAdded';
  payload: MessageAddedPayload;
}

/**
 * Фабрика для создания события MessageAdded
 *
 * Контракт:
 * - aggregateId должен передаваться как каноническое значение ConversationId.toValue().
 *
 * @param aggregateId - Канонический ID беседы (ConversationId.toValue())
 * @param aggregateVersion - Версия агрегата
 * @param payload - Данные события
 * @returns Полностью сформированное событие
 */
export function createMessageAddedEvent(
  aggregateId: string,
  aggregateVersion: number,
  payload: MessageAddedPayload,
  correlationId?: string,
  causationId?: string
): MessageAddedEvent {
  const corr = CorrelationIdProvider.isValid(correlationId)
    ? CorrelationIdProvider.normalize(correlationId)
    : CorrelationIdProvider.generate();
  return {
    eventId: generateEventId(aggregateId),
    type: 'MessageAdded',
    timestamp: new Date(),
    aggregateId,
    aggregateVersion,
    correlationId: corr,
    causationId,
    payload,
  };
}

// ============================================================================
// Дополнительные события для расширения функциональности
// ============================================================================

/**
 * ParticipantAdded - событие добавления участника в беседу
 */
export interface ParticipantAddedPayload {
  participantId: string;
  addedBy: string;
  addedAt: string;
  role?: 'member' | 'admin' | 'observer';
  [key: string]: unknown;
}

export interface ParticipantAddedEvent extends ConversationEvent {
  type: 'ParticipantAdded';
  payload: ParticipantAddedPayload;
}

/**
 * ParticipantRemoved - событие удаления участника из беседы
 */
export interface ParticipantRemovedPayload {
  participantId: string;
  removedBy: string;
  removedAt: string;
  reason?: string;
  [key: string]: unknown;
}

export interface ParticipantRemovedEvent extends ConversationEvent {
  type: 'ParticipantRemoved';
  payload: ParticipantRemovedPayload;
}

/**
 * ConversationArchived - событие архивирования беседы
 */
export interface ConversationArchivedPayload {
  archivedBy: string;
  archivedAt: string;
  reason?: string;
  [key: string]: unknown;
}

export interface ConversationArchivedEvent extends ConversationEvent {
  type: 'ConversationArchived';
  payload: ConversationArchivedPayload;
}

/**
 * Фабрика для создания события ParticipantAdded
 *
 * Контракт:
 * - aggregateId должен передаваться как каноническое значение ConversationId.toValue().
 *
 * @param aggregateId - Канонический ID беседы (ConversationId.toValue())
 * @param aggregateVersion - Версия агрегата
 * @param payload - Данные события
 * @returns Полностью сформированное событие
 */
export function createParticipantAddedEvent(
  aggregateId: string,
  aggregateVersion: number,
  payload: ParticipantAddedPayload,
  correlationId?: string,
  causationId?: string
): ParticipantAddedEvent {
  const corr = CorrelationIdProvider.isValid(correlationId)
    ? CorrelationIdProvider.normalize(correlationId)
    : CorrelationIdProvider.generate();
  return {
    eventId: generateEventId(aggregateId),
    type: 'ParticipantAdded',
    timestamp: new Date(),
    aggregateId,
    aggregateVersion,
    correlationId: corr,
    causationId,
    payload,
  };
}

/**
 * Фабрика для создания события ParticipantRemoved
 *
 * Контракт:
 * - aggregateId должен передаваться как каноническое значение ConversationId.toValue().
 *
 * @param aggregateId - Канонический ID беседы (ConversationId.toValue())
 * @param aggregateVersion - Версия агрегата
 * @param payload - Данные события
 * @returns Полностью сформированное событие
 */
export function createParticipantRemovedEvent(
  aggregateId: string,
  aggregateVersion: number,
  payload: ParticipantRemovedPayload,
  correlationId?: string,
  causationId?: string
): ParticipantRemovedEvent {
  const corr = CorrelationIdProvider.isValid(correlationId)
    ? CorrelationIdProvider.normalize(correlationId)
    : CorrelationIdProvider.generate();
  return {
    eventId: generateEventId(aggregateId),
    type: 'ParticipantRemoved',
    timestamp: new Date(),
    aggregateId,
    aggregateVersion,
    correlationId: corr,
    causationId,
    payload,
  };
}

/**
 * Фабрика для создания события ConversationArchived
 *
 * Контракт:
 * - aggregateId должен передаваться как каноническое значение ConversationId.toValue().
 *
 * @param aggregateId - Канонический ID беседы (ConversationId.toValue())
 * @param aggregateVersion - Версия агрегата
 * @param payload - Данные события
 * @returns Полностью сформированное событие
 */
export function createConversationArchivedEvent(
  aggregateId: string,
  aggregateVersion: number,
  payload: ConversationArchivedPayload,
  correlationId?: string,
  causationId?: string
): ConversationArchivedEvent {
  const corr = CorrelationIdProvider.isValid(correlationId)
    ? CorrelationIdProvider.normalize(correlationId)
    : CorrelationIdProvider.generate();
  return {
    eventId: generateEventId(aggregateId),
    type: 'ConversationArchived',
    timestamp: new Date(),
    aggregateId,
    aggregateVersion,
    correlationId: corr,
    causationId,
    payload,
  };
}

// ============================================================================
// Union-тип всех событий Conversation
// ============================================================================

/**
 * Объединенный тип всех доменных событий Conversation
 * Используется для типобезопасной обработки событий
 */
export type ConversationDomainEvent =
  | ConversationCreatedEvent
  | MessageAddedEvent
  | ParticipantAddedEvent
  | ParticipantRemovedEvent
  | ConversationArchivedEvent;

/**
 * Zod‑схемы payload'ов доменных событий
 */
const ConversationCreatedPayloadSchema = z.object({
  createdBy: z.string().min(1),
  title: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  participantIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const MessageAddedPayloadSchema = z.object({
  messageId: z.string().min(1),
  content: z.string().min(1),
  authorId: z.string().min(1),
  createdAt: z.string().min(1),
  messageType: z.enum(['text', 'image', 'file', 'system']).optional(),
  parentMessageId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ParticipantAddedPayloadSchema = z.object({
  participantId: z.string().min(1),
  addedBy: z.string().min(1),
  addedAt: z.string().min(1),
  role: z.enum(['member', 'admin', 'observer']).optional(),
});

const ParticipantRemovedPayloadSchema = z.object({
  participantId: z.string().min(1),
  removedBy: z.string().min(1),
  removedAt: z.string().min(1),
  reason: z.string().min(1).optional(),
});

const ConversationArchivedPayloadSchema = z.object({
  archivedBy: z.string().min(1),
  archivedAt: z.string().min(1),
  reason: z.string().min(1).optional(),
});

/**
 * Общая базовая схема доменного события (тип и общие поля)
 */
const BaseConversationEventSchema = z.object({
  eventId: z.string().min(1),
  timestamp: z.instanceof(Date),
  aggregateId: z.string().min(1),
  aggregateVersion: z.number().int().nonnegative(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
});

/**
 * Полные схемы доменных событий
 */
export const ConversationCreatedEventSchema = BaseConversationEventSchema.extend({
  type: z.literal('ConversationCreated'),
  payload: ConversationCreatedPayloadSchema,
});

export const MessageAddedEventSchema = BaseConversationEventSchema.extend({
  type: z.literal('MessageAdded'),
  payload: MessageAddedPayloadSchema,
});

export const ParticipantAddedEventSchema = BaseConversationEventSchema.extend({
  type: z.literal('ParticipantAdded'),
  payload: ParticipantAddedPayloadSchema,
});

export const ParticipantRemovedEventSchema = BaseConversationEventSchema.extend({
  type: z.literal('ParticipantRemoved'),
  payload: ParticipantRemovedPayloadSchema,
});

export const ConversationArchivedEventSchema = BaseConversationEventSchema.extend({
  type: z.literal('ConversationArchived'),
  payload: ConversationArchivedPayloadSchema,
});

/**
 * Union‑схема всех событий Conversation
 */
export const ConversationDomainEventSchema = z.union([
  ConversationCreatedEventSchema,
  MessageAddedEventSchema,
  ParticipantAddedEventSchema,
  ParticipantRemovedEventSchema,
  ConversationArchivedEventSchema,
]);

/**
 * Runtime‑валидация и type‑guards
 */
export function validateConversationCreatedEvent(input: unknown): ConversationCreatedEvent {
  return ConversationCreatedEventSchema.parse(input);
}
export function validateMessageAddedEvent(input: unknown): MessageAddedEvent {
  return MessageAddedEventSchema.parse(input);
}
export function validateParticipantAddedEvent(input: unknown): ParticipantAddedEvent {
  return ParticipantAddedEventSchema.parse(input);
}
export function validateParticipantRemovedEvent(input: unknown): ParticipantRemovedEvent {
  return ParticipantRemovedEventSchema.parse(input);
}
export function validateConversationArchivedEvent(input: unknown): ConversationArchivedEvent {
  return ConversationArchivedEventSchema.parse(input);
}

export function isConversationCreatedEvent(e: unknown): e is ConversationCreatedEvent {
  return ConversationCreatedEventSchema.safeParse(e).success;
}
export function isMessageAddedEvent(e: unknown): e is MessageAddedEvent {
  return MessageAddedEventSchema.safeParse(e).success;
}
export function isParticipantAddedEvent(e: unknown): e is ParticipantAddedEvent {
  return ParticipantAddedEventSchema.safeParse(e).success;
}
export function isParticipantRemovedEvent(e: unknown): e is ParticipantRemovedEvent {
  return ParticipantRemovedEventSchema.safeParse(e).success;
}
export function isConversationArchivedEvent(e: unknown): e is ConversationArchivedEvent {
  return ConversationArchivedEventSchema.safeParse(e).success;
}

export function isConversationDomainEvent(e: unknown): e is ConversationDomainEvent {
  return ConversationDomainEventSchema.safeParse(e).success;
}

// ============================================================================
// Утилиты для работы с событиями
// ============================================================================

/**
 * Генерирует уникальный ID для события
 * 
 * @param aggregateId - ID агрегата
 * @returns Уникальный ID события
 */
function generateEventId(aggregateId: string): string {
  const timestamp = Date.now();
  const random = randomUUID().replace(/-/g, '').slice(0, 9);
  return `evt_${aggregateId}_${timestamp}_${random}`;
}

function generateCorrelationId(): string {
  return CorrelationIdProvider.generate('corr');
}

/**
 * Type guard для проверки типа события
 * 
 * @param event - Событие для проверки
 * @returns true если событие имеет указанный тип
 */
export function isEventType<T extends ConversationDomainEvent['type']>(
  event: ConversationDomainEvent,
  type: T
): event is Extract<ConversationDomainEvent, { type: T }> {
  return event.type === type;
}

/**
 * Валидирует структуру доменного события
 * 
 * @param event - Событие для валидации
 * @returns true если структура валидна
 */
export function isValidConversationEvent(event: unknown): event is ConversationDomainEvent {
  return ConversationDomainEventSchema.safeParse(event).success;
}

/**
 * Сериализует событие для сохранения в БД или передачи по сети
 * 
 * @param event - Событие для сериализации
 * @returns JSON-представление события
 */
export function serializeEvent(event: ConversationDomainEvent): string {
  return JSON.stringify({
    ...event,
    timestamp: event.timestamp.toISOString(),
  });
}

/**
 * Десериализует событие из JSON
 * 
 * @param json - JSON-строка события
 * @returns Восстановленное событие
 * @throws Error если JSON невалиден
 */
export function deserializeEvent(json: string): ConversationDomainEvent {
  const parsed = safeJsonParse<unknown>(json);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid event JSON');
  }

  const event = parsed as { timestamp: string } & Record<string, unknown>;

  return {
    ...event,
    timestamp: new Date(event.timestamp),
  } as ConversationDomainEvent;
}

/**
 * Получить читаемое описание события для логирования
 * 
 * @param event - Событие
 * @returns Строковое описание
 */
export function getEventDescription(event: ConversationDomainEvent): string {
  switch (event.type) {
    case 'ConversationCreated':
      return `Создана беседа ${event.aggregateId} пользователем ${event.payload.createdBy}`;
    case 'MessageAdded':
      return `Добавлено сообщение ${event.payload.messageId} от ${event.payload.authorId}`;
    case 'ParticipantAdded':
      return `Добавлен участник ${event.payload.participantId}`;
    case 'ParticipantRemoved':
      return `Удален участник ${event.payload.participantId} пользователем ${event.payload.removedBy}`;
    case 'ConversationArchived':
      return `Беседа архивирована пользователем ${event.payload.archivedBy}`;
    default:
      return `Неизвестное событие: ${(event as ConversationDomainEvent).type}`;
  }
}