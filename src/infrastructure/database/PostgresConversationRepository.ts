/**
 * Conversation Repository для PostgreSQL - Infrastructure реализация
 * Layer: Infrastructure
 * 
 * Конкретная реализация IConversationRepository для PostgreSQL.
 * Соблюдает принципы Dependency Inversion - зависит от интерфейса из Domain.
 */

import {
  IConversationRepository,
  RepositoryResult,
  RepositoryError,
  FindConversationsOptions,
  ConversationSearchResult,
} from '../../domain/conversation/IConversationRepository';
import {
  Conversation,
  type Message as ConversationMessage,
} from '../../domain/conversation/Conversation';
import { ConversationId } from '../../domain/conversation/ConversationId';
import { ParticipantId } from '../../domain/conversation/ParticipantId';
import { MessageId } from '../../domain/conversation/MessageId';
import { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { Timestamp } from '../../core/types';
import { getConfig } from '../../config';
import { safeJsonParse } from '../../core/utils/json';
import type { IOutbox } from '../../domain/events/outbox.interface';
import type { IEventStore } from '../../domain/events/event-store.interface';
import { DomainEvent as StoreEvent } from '../../domain/events/event-store.interface';
import type { ConversationDomainEvent } from '../../domain/conversation/events';
import { PostgreSQLOutbox } from '../events/postgres-outbox';
import { requireActivePgClient } from './PostgresAdapter';
import type { PoolClient } from 'pg';

function readStoredJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    return safeJsonParse<T>(value, fallback) ?? fallback;
  }
  if (value !== null && typeof value === 'object') {
    return value as T;
  }
  return fallback;
}

/** Maps conversation domain events onto the event-store shape. */
function toDotCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1.$2').replace(/[\s_]+/g, '.').toLowerCase();
}
function mapConversationEventType(eventType: ConversationDomainEvent['type']): string {
  const map: Record<string, string> = {
    ConversationCreated: 'conversation.created',
    MessageAdded: 'message.added',
    ParticipantAdded: 'participant.added',
    ParticipantRemoved: 'participant.removed',
    ConversationArchived: 'conversation.archived',
  };
  return map[eventType] ?? toDotCase(String(eventType));
}
function mapConversationEventToStoreEvent(e: ConversationDomainEvent): StoreEvent {
  return {
    eventId: (e as { eventId: string }).eventId,
    type: 'ConversationSaved',
    aggregateId: (e as { aggregateId: string }).aggregateId,
    aggregateVersion: (e as { aggregateVersion: number }).aggregateVersion,
    correlationId: (e as { correlationId?: string }).correlationId || '',
    causationId: (e as { causationId?: string }).causationId,
    timestamp: (e as { timestamp: Date }).timestamp,
    payload: (e as { payload: Record<string, unknown> }).payload,
    metadata: undefined,
  };
}

/**
 * Строка read‑model для таблицы messages, используемой для хранения истории
 * сообщений бесед (TASK‑008).
 */
interface DbMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  author_id: string;
  content: string;
  message_type: string | null;
  parent_message_id: string | null;
  created_at: Date | string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Роль сообщения в таблице messages.
 */
type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Лимит по умолчанию для истории сообщений.
 */
const DEFAULT_HISTORY_LIMIT = 50;

/**
 * Нормализация типа сообщения, считанного из БД.
 */
function normalizeMessageTypeFromDb(
  value: string | null,
): ConversationMessage['messageType'] {
  if (value === 'image' || value === 'file' || value === 'system') {
    return value;
  }
  return 'text';
}

/**
 * Нормализация метаданных сообщения, считанных из БД.
 */
function normalizeMetadataFromDb(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return value;
}

export class PostgresConversationRepository implements IConversationRepository {
  /**
   * @param db - Database connection (required)
   * @param outbox - Outbox for transactional event persistence (optional, injected via DI)
   * @param eventStore - Event store for direct event persistence (optional, injected via DI)
   */
  constructor(
    private readonly db: IDatabaseConnection,
    private readonly outbox?: IOutbox,
    private readonly eventStore?: IEventStore,
  ) {}

  async findById(id: ConversationId): Promise<RepositoryResult<Conversation>> {
    try {
      const result = await this.db.query(
        'SELECT * FROM conversations WHERE id = $1 AND status != $2',
        [id.toValue(), 'deleted']
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          error: RepositoryError.notFound(id.toValue())
        };
      }

      const history = await this.getMessageHistory(id);
      if (!history.success) {
        return { success: false, error: history.error };
      }

      // Восстанавливаем агрегат из данных вместе с уже записанными сообщениями.
      const conversation = this.hydrateFromDb(result.rows[0] as {
        id: string;
        created_by: string;
        status: string;
        participants?: string;
        metadata?: unknown;
        version?: number;
        created_at: string;
        updated_at: string;
      }, history.data);
      return { success: true, data: conversation };

    } catch (error) {
      return {
        success: false,
        error: RepositoryError.connectionError('Failed to find conversation', error as Error)
      };
    }
  }

  async findByIdOrNull(id: ConversationId): Promise<Conversation | null> {
    const result = await this.findById(id);
    return result.success ? result.data : null;
  }

  async find(options: FindConversationsOptions): Promise<RepositoryResult<ConversationSearchResult>> {
    try {
      let query = 'SELECT * FROM conversations WHERE status != $1';
      const params: unknown[] = ['deleted'];
      let paramIndex = 2;

      // Применяем фильтры
      if (options.participantId) {
        query += ` AND participants::jsonb ? $${paramIndex}`;
        params.push(options.participantId);
        paramIndex++;
      }

      if (options.createdBy) {
        query += ` AND created_by = $${paramIndex}`;
        params.push(options.createdBy);
        paramIndex++;
      }

      if (options.status) {
        query += ` AND status = $${paramIndex}`;
        params.push(options.status);
        paramIndex++;
      }

      // Сортировка - TASK-019: whitelist validation to prevent SQL injection
      const SORT_COLUMNS: Record<string, string> = {
        created_at: 'created_at',
        createdat: 'created_at',
        updated_at: 'updated_at',
        updatedat: 'updated_at',
        status: 'status',
        id: 'id',
        created_by: 'created_by',
        createdby: 'created_by',
      };
      const requestedSortBy = (options.sortBy || 'created_at').toLowerCase().trim();
      const sortBy = SORT_COLUMNS[requestedSortBy];
      if (!sortBy) {
        throw new Error('Invalid sort column: ' + String(options.sortBy ?? 'undefined') + '. Allowed: ' + Object.keys(SORT_COLUMNS).join(', '));
      }
      const sortOrder = options.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      query += ` ORDER BY ${sortBy} ${sortOrder}`;

      // Пагинация
      const limit = options.limit || 10;
      const offset = options.offset || 0;
      query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await this.db.query(query, params);
      
      const conversations = result.rows.map(row => this.hydrateFromDb(row as {
        id: string;
        created_by: string;
        status: string;
        participants?: string;
        metadata?: string;
        version?: number;
        created_at: string;
        updated_at: string;
      }));
      const total = await this.getTotalCount(options);

      return {
        success: true,
        data: {
          conversations,
          total,
          count: conversations.length,
          offset,
          limit
        }
      };

    } catch (error) {
      return {
        success: false,
        error: RepositoryError.connectionError('Failed to find conversations', error as Error)
      };
    }
  }

  async save(conversation: Conversation): Promise<RepositoryResult<Conversation>> {
    try {
      const pendingEvents = conversation.getEvents() as ConversationDomainEvent[];
      
      if (pendingEvents.length === 0) {
        console.warn('No events to save for conversation:', conversation.conversationId.toValue());
        return { success: true, data: conversation };
      }

      // Явная конфигурация: выбираем стратегию сохранения событий
      const { EVENT_PERSISTENCE_MODE } = getConfig();
      const eventPersistenceMode = EVENT_PERSISTENCE_MODE || 'outbox-transactional';
      const persistedVersionBeforeSave = conversation.version - pendingEvents.length;

      await this.db.transaction(async () => {
        // Гарантируем наличие активного PostgreSQL клиента для всей транзакции.
        const client: PoolClient = requireActivePgClient(
          'PostgresConversationRepository.save',
        );

        // Проверяем версию для optimistic locking в рамках того же клиента.
        const versionResult = await client.query<{ version: number }>(
          'SELECT version FROM conversations WHERE id = $1',
          [conversation.conversationId.toValue()],
        );
        const versionRow = versionResult.rows[0];

        if (versionRow && versionRow.version !== persistedVersionBeforeSave) {
          throw RepositoryError.conflict(conversation.conversationId.toValue());
        }

        // Сохраняем агрегат (read-model upsert) через транзакционный клиент,
        // без fallback на autocommit.
        const dbData = this.dehydrateToDb(conversation);
        await client.query(
          `INSERT INTO conversations (
             id, created_by, participants, status, version, created_at, updated_at, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             created_by = EXCLUDED.created_by,
             participants = EXCLUDED.participants,
             status = EXCLUDED.status,
             version = EXCLUDED.version,
             updated_at = EXCLUDED.updated_at,
             metadata = EXCLUDED.metadata`,
          [
            dbData.id,
            dbData.created_by,
            dbData.participants,
            dbData.status,
            dbData.version,
            dbData.created_at,
            dbData.updated_at,
            dbData.metadata
          ],
        );

        await this.saveMessageHistoryTransactional(pendingEvents, client);

        // Сохраняем события согласно выбранной стратегии
        if (eventPersistenceMode === 'outbox-transactional') {
          await this.saveEventsOutboxTransactional(pendingEvents, client);
        } else if (eventPersistenceMode === 'eventstore-transactional') {
          await this.saveEventsEventStoreTransactional(pendingEvents);
        } else if (eventPersistenceMode === 'outbox-post-commit') {
          // События будут сохранены после коммита
          this.schedulePostCommitEventSave(pendingEvents);
        } else {
          throw new Error(`Unknown event persistence mode: ${eventPersistenceMode}`);
        }
      });

      // Очищаем доменные события после успешной персистенции
      conversation.clearEvents();

      return { success: true, data: conversation };
    } catch (error) {
      if (error instanceof RepositoryError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: RepositoryError.connectionError('Failed to save conversation', error as Error)
      };
    }
  }

  /**
   * Сохранение истории сообщений в таблицу messages в рамках активной транзакции.
   * История строится на основе событий MessageAdded.
   */
  private async saveMessageHistoryTransactional(
    events: ConversationDomainEvent[],
    client: PoolClient,
  ): Promise<void> {
    const messageEvents = events.filter(
      (event) => event.type === 'MessageAdded',
    );

    if (messageEvents.length === 0) {
      return;
    }

    for (const event of messageEvents) {
      const payload = event.payload;
      const createdAt = new Date(payload.createdAt);
      const metadataRole = payload.metadata?.['role'];
      const role: MessageRole =
        metadataRole === 'assistant' || metadataRole === 'system' ? metadataRole : 'user';

      await client.query(
        `INSERT INTO messages (
           id,
           conversation_id,
           role,
           author_id,
           content,
           message_type,
           parent_message_id,
           created_at,
           metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          payload.messageId,
          (event as { aggregateId: string }).aggregateId,
          role,
          payload.authorId,
          payload.content,
          payload.messageType ?? null,
          payload.parentMessageId ?? null,
          createdAt,
          payload.metadata ?? null,
        ],
      );
    }
  }

  /**
   * Сохранение событий через Outbox в транзакции.
   * Клиент PostgreSQL передаётся явно, чтобы избежать скрытой зависимости от AsyncLocalStorage.
   */
  private async saveEventsOutboxTransactional(
    events: ConversationDomainEvent[],
    client: PoolClient,
  ): Promise<void> {
    const outbox = this.outbox;
    if (!outbox) {
      throw new Error('IOutbox is not available for transactional event persistence');
    }

    const mappedEvents = events.map(ev => mapConversationEventToStoreEvent(ev));
    await (outbox as PostgreSQLOutbox).saveEventsWithOutboxInTxClient(client, mappedEvents);
  }

  /**
   * Сохранение событий напрямую в Event Store в транзакции
   */
  private async saveEventsEventStoreTransactional(events: ConversationDomainEvent[]): Promise<void> {
    if (!this.eventStore) {
      throw new Error('IEventStore is not available for transactional event persistence');
    }
    const mappedEvents = events.map(ev => mapConversationEventToStoreEvent(ev));
    await this.eventStore.saveEvents(mappedEvents, { transactional: true, validateEvents: false });
  }

  /**
   * Планирование сохранения событий после коммита
   */
  private schedulePostCommitEventSave(events: ConversationDomainEvent[]): void {
    // В реальном приложении здесь бы использовался event emitter или очередь
    // Для простоты используем setImmediate
    const outbox = this.outbox;
    const eventStore = this.eventStore;
    setImmediate(async () => {
      try {
        if (outbox) {
          const mappedEvents = events.map(ev => mapConversationEventToStoreEvent(ev));
          await (outbox as { saveEventsWithOutbox: (events: StoreEvent[]) => Promise<unknown> }).saveEventsWithOutbox(mappedEvents);
        } else if (eventStore) {
          const mappedEvents = events.map(ev => mapConversationEventToStoreEvent(ev));
          await eventStore.saveEvents(mappedEvents, { transactional: false, validateEvents: false });
        } else {
          console.error('Neither IOutbox nor IEventStore available for post-commit event save');
        }
      } catch (error) {
        console.error('Failed to save events post-commit:', error);
        // В продакшене здесь должна быть отправка в dead-letter queue
      }
    });
  }

  // resolveOutbox() removed - now using constructor-injected this.outbox (TASK-002)

  async delete(id: ConversationId): Promise<RepositoryResult<void>> {
    try {
      // Soft delete - помечаем как удаленную
      const result = await this.db.query(
        'UPDATE conversations SET status = $1, updated_at = $2 WHERE id = $3',
        ['deleted', new Date(), id.toValue()]
      );

      if (result.rowCount === 0) {
        return {
          success: false,
          error: RepositoryError.notFound(id.toValue())
        };
      }

      return { success: true, data: undefined };

    } catch (error) {
      return {
        success: false,
        error: RepositoryError.connectionError('Failed to delete conversation', error as Error)
      };
    }
  }

  async exists(id: ConversationId): Promise<boolean> {
    try {
      const result = await this.db.query(
        'SELECT 1 FROM conversations WHERE id = $1 AND status != $2',
        [id.toValue(), 'deleted']
      );
      return result.rows.length > 0;

    } catch (error) {
      console.error('Failed to check conversation existence:', error);
      return false;
    }
  }

  async count(options?: Omit<FindConversationsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number> {
    return this.getTotalCount(options || {});
  }

  async getMessageHistory(
    id: ConversationId,
    options?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<RepositoryResult<ReadonlyArray<ConversationMessage>>> {
    try {
      const limit = options?.limit ?? DEFAULT_HISTORY_LIMIT;
      const offset = options?.offset ?? 0;

      const safeLimit = limit > 0 ? limit : 0;
      const safeOffset = offset > 0 ? offset : 0;

      const result = await this.db.query<DbMessageRow>(
        `SELECT
           id,
           conversation_id,
           role,
           author_id,
           content,
           message_type,
           parent_message_id,
           created_at,
           metadata
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [id.toValue(), safeLimit, safeOffset],
      );

      // Возвращаем сообщения в хронологическом порядке (от самых старых к новым)
      const rowsInChronologicalOrder = [...result.rows].reverse();

      const messages: ConversationMessage[] = rowsInChronologicalOrder.map(
        (row) => {
          const createdAtIso =
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : String(row.created_at);

          const messageType = normalizeMessageTypeFromDb(row.message_type);

          const parentMessageIdValue =
            row.parent_message_id && row.parent_message_id.length > 0
              ? row.parent_message_id
              : undefined;

          const metadata = normalizeMetadataFromDb(row.metadata);

          return {
            id: MessageId.fromString(row.id),
            content: row.content,
            authorId: ParticipantId.fromString(row.author_id),
            createdAt: Timestamp.fromString(createdAtIso),
            messageType,
            parentMessageId: parentMessageIdValue
              ? MessageId.fromString(parentMessageIdValue)
              : undefined,
            metadata,
          };
        },
      );

      return {
        success: true,
        data: messages,
      };
    } catch (error) {
      return {
        success: false,
        error: RepositoryError.connectionError(
          'Failed to load conversation message history',
          error instanceof Error ? error : new Error('Unknown error'),
        ),
      };
    }
  }
  
  // Приватные методы для маппинга данных
  private hydrateFromDb(dbRow: {
    id: string;
    created_by: string;
    status: string;
    participants?: unknown;
    metadata?: unknown;
    version?: number;
    created_at: string;
    updated_at: string
  }, messages: ReadonlyArray<ConversationMessage> = []): Conversation {
    // Восстановление агрегата из упрощенной read‑model записи
    const createdAtTs = Timestamp.fromString(new Date(dbRow.created_at).toISOString());
    const updatedAtTs = Timestamp.fromString(new Date(dbRow.updated_at).toISOString());

    const participantsArray = readStoredJson<string[]>(dbRow.participants, []);
    const metadata = readStoredJson<Record<string, unknown> | null>(dbRow.metadata, null);
    const title = typeof metadata?.['title'] === 'string' ? metadata['title'] : undefined;
    const creatorId = ParticipantId.fromString(dbRow.created_by).toValue();
    
    const props = {
      createdBy: dbRow.created_by,
      title,
      createdAt: createdAtTs,
      messages: [...messages],
      participants: participantsArray.map((pid: string) => ({
        id: ParticipantId.fromString(pid),
        role: pid === creatorId ? 'admin' as const : 'member' as const,
        joinedAt: createdAtTs,
      })),
      status: dbRow.status as 'active' | 'archived' | 'deleted',
      updatedAt: updatedAtTs,
      metadata: metadata ?? undefined,
    };

    return Conversation.restore(
      ConversationId.fromString(dbRow.id),
      props,
      dbRow.version || 0
    );
  }

  private dehydrateToDb(conversation: Conversation): {
    id: string;
    created_by: string;
    participants: string;
    status: string;
    version: number;
    created_at: Date;
    updated_at: Date;
    metadata: string | null;
  } {
    return {
      id: conversation.conversationId.toValue(),
      created_by: conversation.createdBy,
      participants: JSON.stringify(conversation.participants.map(p => p.id.toValue())),
      status: conversation.status,
      version: conversation.version,
      created_at: conversation.createdAt.toDate(),
      updated_at: conversation.updatedAt.toDate(),
      metadata: JSON.stringify({
        ...(conversation.metadata ?? {}),
        ...(conversation.title ? { title: conversation.title } : {}),
      })
    };
  }

  private async getTotalCount(options: Omit<FindConversationsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number> {
    let query = 'SELECT COUNT(*) as total FROM conversations WHERE status != $1';
    const params: unknown[] = ['deleted'];
    let paramIndex = 2;

    if (options.participantId) {
      query += ` AND participants::jsonb ? $${paramIndex}`;
      params.push(options.participantId);
      paramIndex++;
    }

    if (options.createdBy) {
      query += ` AND created_by = $${paramIndex}`;
      params.push(options.createdBy);
      paramIndex++;
    }

    if (options.status) {
      query += ` AND status = $${paramIndex}`;
      params.push(options.status);
      paramIndex++;
    }

    const result = await this.db.query<{ total: string }>(query, params);
    return parseInt(result.rows[0].total, 10);
  }
}