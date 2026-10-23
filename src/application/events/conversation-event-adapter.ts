import { RequestContext } from '../context/request-context';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import {
  DomainEvent,
  IEventStore,
  SaveEventsResult,
} from '../../domain/events/event-store.interface';
import {
  ConversationDomainEvent,
} from '../../domain/conversation/events';

/**
 * Преобразование ConversationDomainEvent (type) → DomainEvent (eventType)
 * + инъекция correlationId из RequestContext (если отсутствует в событии)
 */

/**
 * Явное сопоставление известных типов
 */
function mapConversationEventType(eventType: ConversationDomainEvent['type']): string {
  const map: Record<ConversationDomainEvent['type'], string> = {
    ConversationCreated: 'conversation.created',
    MessageAdded: 'message.added',
    ParticipantAdded: 'participant.added',
    ParticipantRemoved: 'participant.removed',
    ConversationArchived: 'conversation.archived',
  };
  return map[eventType] ?? toDotCase(eventType);
}

/**
 * Fallback: CamelCase → dot.case (ConversationCreated → conversation.created)
 */
function toDotCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .replace(/[\s_]+/g, '.')
    .toLowerCase();
}

/**
 * Получить нормализованный correlationId:
 * 1) Из события, если присутствует и непустой
 * 2) Из RequestContext (если доступен)
 * 3) Сгенерировать безопасный fallback
 */
function getNormalizedCorrelationId(existing?: string): string {
  if (CorrelationIdProvider.isValid(existing)) {
    return (existing).trim();
  }

  try {
    const ctxId = RequestContext.getCorrelationId();
    if (CorrelationIdProvider.isValid(ctxId)) {
      return ctxId;
    }
  } catch {
    // контекст не инициализирован — игнорируем
  }

  // Единый fallback через провайдер
  return CorrelationIdProvider.generate();
}

/**
 * Преобразование одного события
 */
export function toDomainEvent(e: ConversationDomainEvent): DomainEvent {
  return {
    eventId: e.eventId,
    type: e.type,
    aggregateId: e.aggregateId,
    aggregateVersion: e.aggregateVersion,
    correlationId: getNormalizedCorrelationId(e.correlationId),
    causationId: e.causationId,
    timestamp: e.timestamp,
    payload: e.payload,
    metadata: undefined,
  };
}

/**
 * Преобразование нескольких событий
 */
export function toDomainEvents(events: ConversationDomainEvent[]): DomainEvent[] {
  return events.map(toDomainEvent);
}

/**
 * Утилита сохранения в Event Store (append-only)
 */
export async function saveConversationEvents(
  store: IEventStore,
  events: ConversationDomainEvent[],
): Promise<SaveEventsResult> {
  const mapped = toDomainEvents(events);
  return store.saveEvents(mapped, { transactional: true, validateEvents: false });
}