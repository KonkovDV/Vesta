/**
 * ResearchReport Repository для PostgreSQL - Infrastructure реализация
 * Layer: Infrastructure
 *
 * Конкретная реализация IResearchReportRepository для PostgreSQL.
 * Соблюдает принципы Dependency Inversion - зависит от интерфейса из Domain.
 */

import {
  IResearchReportRepository,
  RepositoryResult,
  RepositoryError,
  FindResearchReportsOptions,
  ResearchReportSearchResult
} from '../../domain/research/IResearchReportRepository';
import { ResearchReport } from '../../domain/research/ResearchReport';
import { ResearchReportId } from '../../domain/research/ResearchReport';
import { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { getConfig } from '../../config';
import type { IOutbox } from '../../domain/events/outbox.interface';
import type { IEventStore } from '../../domain/events/event-store.interface';
import { DomainEvent as StoreEvent } from '../../domain/events/event-store.interface';
import type { ResearchDomainEvent } from '../../domain/research/events';
import { PostgreSQLOutbox } from '../events/postgres-outbox';
import { requireActivePgClient } from './PostgresAdapter';
import type { PoolClient } from 'pg';

/**
 * PostgreSQL реализация ResearchReport Repository
 *
 * Использует PostgreSQL для persistence с поддержкой:
 * - Optimistic locking для конкурентного доступа
 * - Transactциональные операции
 * - Индексы для быстрого поиска
 * - Soft delete для аудита
 */

/** Helpers to map ResearchDomainEvent -> StoreEvent for persistence */
function mapResearchEventType(eventType: ResearchDomainEvent['type']): string {
  const map: Record<string, string> = {
    ResearchReportCreated: 'research.report.created',
    ArticleAdded: 'research.article.added',
    ArticleSummarized: 'research.article.summarized',
    TrendsAnalyzed: 'research.trends.analyzed',
    ResearchReportFinalized: 'research.report.finalized',
  };
  return map[eventType] ?? eventType.toLowerCase().replace(/([A-Z])/g, '.$1').toLowerCase();
}

function mapResearchEventToStoreEvent(e: ResearchDomainEvent): StoreEvent {
  return {
    eventId: (e as { eventId: string }).eventId,
    type: mapResearchEventType(e.type),
    aggregateId: (e as { aggregateId: string }).aggregateId,
    aggregateVersion: (e as { aggregateVersion: number }).aggregateVersion,
    correlationId: (e as { correlationId?: string }).correlationId || '',
    causationId: (e as { causationId?: string }).causationId,
    timestamp: (e as { timestamp: Date }).timestamp,
    payload: (e as { payload: Record<string, unknown> }).payload,
    metadata: undefined,
  };
}

function mapStoreEventTypeToResearchEventType(storeType: string): ResearchDomainEvent['type'] {
  const reverse: Record<string, ResearchDomainEvent['type']> = {
    'research.report.created': 'ResearchReportCreated',
    'research.article.added': 'ArticleAdded',
    'research.article.summarized': 'ArticleSummarized',
    'research.trends.analyzed': 'TrendsAnalyzed',
    'research.report.finalized': 'ResearchReportFinalized',
  };
  return reverse[storeType] ?? (storeType as ResearchDomainEvent['type']);
}

export class PostgresResearchReportRepository implements IResearchReportRepository {
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

  async findById(id: ResearchReportId): Promise<RepositoryResult<ResearchReport>> {
    try {
      const result = await this.db.query(
        'SELECT * FROM research_reports WHERE id = $1 AND status != $2',
        [id.toValue(), 'deleted']
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          error: RepositoryError.notFound(id.toValue())
        };
      }

      // Восстанавливаем агрегат из данных
      const report = this.hydrateFromDb(result.rows[0] as {
        id: string;
        topic: string;
        status: string;
        created_by: string;
        created_at: string;
        completed_at?: string;
        version?: number;
      });
      return { success: true, data: report };

    } catch (error) {
      return {
        success: false,
        error: RepositoryError.connectionError('Failed to find research report', error as Error)
      };
    }
  }

  async findByIdOrNull(id: ResearchReportId): Promise<ResearchReport | null> {
    const result = await this.findById(id);
    return result.success ? result.data : null;
  }

  async find(options: FindResearchReportsOptions): Promise<RepositoryResult<ResearchReportSearchResult>> {
    try {
      let query = 'SELECT * FROM research_reports WHERE status != $1';
      const params: unknown[] = ['deleted'];
      let paramIndex = 2;

      // Применяем фильтры
      if (options.researcherId) {
        query += ` AND created_by = $${paramIndex}`;
        params.push(options.researcherId);
        paramIndex++;
      }

      if (options.status) {
        query += ` AND status = $${paramIndex}`;
        params.push(options.status);
        paramIndex++;
      }

      if (options.topicKeywords && options.topicKeywords.length > 0) {
        const keywordConditions = options.topicKeywords.map((_, idx) => `$${paramIndex + idx} = ANY(string_to_array(topic, ' '))`).join(' OR ');
        query += ` AND (${keywordConditions})`;
        params.push(...options.topicKeywords);
        paramIndex += options.topicKeywords.length;
      }

      // Сортировка - TASK-019: whitelist validation to prevent SQL injection
      const ALLOWED_SORT_COLUMNS = new Set(['created_at', 'completed_at', 'status', 'id', 'topic', 'created_by']);
      const requestedSortBy = (options.sortBy || 'created_at').toLowerCase().trim();
      if (!ALLOWED_SORT_COLUMNS.has(requestedSortBy)) {
        throw new Error('Invalid sort column: ' + String(options.sortBy ?? 'undefined') + '. Allowed: ' + Array.from(ALLOWED_SORT_COLUMNS).join(', '));
      }
      const sortBy = requestedSortBy;
      const sortOrder = options.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      query += ` ORDER BY ${sortBy} ${sortOrder}`;

      // Пагинация
      const limit = options.limit || 10;
      const offset = options.offset || 0;
      query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await this.db.query(query, params);

      const reports = result.rows.map(row => this.hydrateFromDb(row as {
        id: string;
        topic: string;
        status: string;
        created_by: string;
        created_at: string;
        completed_at?: string;
        version?: number;
      }));
      const total = await this.getTotalCount(options);

      return {
        success: true,
        data: {
          reports,
          total,
          count: reports.length,
          offset,
          limit
        }
      };

    } catch (error) {
      return {
        success: false,
        error: RepositoryError.connectionError('Failed to find research reports', error as Error)
      };
    }
  }

  private static readonly SNAPSHOT_FREQUENCY = 100;

  async save(report: ResearchReport): Promise<RepositoryResult<ResearchReport>> {
    try {
      const pendingEvents = report.getEvents() as ResearchDomainEvent[];

      if (pendingEvents.length === 0) {
        console.warn('No events to save for research report:', report.id.toValue());
        return { success: true, data: report };
      }

      // Явная конфигурация: выбираем стратегию сохранения событий
      const { EVENT_PERSISTENCE_MODE } = getConfig();
      const eventPersistenceMode = EVENT_PERSISTENCE_MODE || 'outbox-transactional';
      const persistedVersionBeforeSave = report.version - pendingEvents.length;

      await this.db.transaction(async () => {
        // Гарантируем наличие активного PostgreSQL клиента для всей транзакции.
        const client: PoolClient = requireActivePgClient(
          'PostgresResearchReportRepository.save',
        );

        // Проверяем версию для optimistic locking в рамках того же клиента.
        const versionResult = await client.query<{ version: number }>(
          'SELECT version FROM research_reports WHERE id = $1',
          [report.id.toValue()],
        );
        const versionRow = versionResult.rows[0];

        if (versionRow && versionRow.version !== persistedVersionBeforeSave) {
          throw RepositoryError.conflict(report.id.toValue());
        }

        // Сохраняем агрегат (read-model upsert) через транзакционный клиент,
        // без fallback на autocommit.
        const dbData = this.dehydrateToDb(report);
        await client.query(
          `INSERT INTO research_reports (
             id, topic, status, created_by, version, created_at, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             topic = EXCLUDED.topic,
             status = EXCLUDED.status,
             completed_at = EXCLUDED.completed_at,
             version = EXCLUDED.version`,
          [
            dbData.id,
            dbData.topic,
            dbData.status,
            dbData.created_by,
            dbData.version,
            dbData.created_at,
            dbData.completed_at
          ]
        );

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
      report.clearEvents();

      // Автоматическое создание snapshot каждые SNAPSHOT_FREQUENCY событий.
      await this.maybeCreateSnapshot(report);

      return { success: true, data: report };
    } catch (error) {
      if (error instanceof RepositoryError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: RepositoryError.connectionError('Failed to save research report', error as Error)
      };
    }
  }

  /**
   * Сохранение событий через Outbox в транзакции.
   * Клиент PostgreSQL передаётся явно, чтобы избежать скрытой зависимости от AsyncLocalStorage.
   */
  private async saveEventsOutboxTransactional(
    events: ResearchDomainEvent[],
    client: PoolClient,
  ): Promise<void> {
    const outbox = this.outbox;
    if (!outbox) {
      throw new Error('IOutbox is not available for transactional event persistence');
    }

    const mappedEvents = events.map(ev => mapResearchEventToStoreEvent(ev));
    await (outbox as PostgreSQLOutbox).saveEventsWithOutboxInTxClient(client, mappedEvents);
  }

  /**
   * Сохранение событий напрямую в Event Store в транзакции
   */
  private async saveEventsEventStoreTransactional(events: ResearchDomainEvent[]): Promise<void> {
    if (!this.eventStore) {
      throw new Error('IEventStore is not available for transactional event persistence');
    }
    const mappedEvents = events.map(ev => mapResearchEventToStoreEvent(ev));
    await this.eventStore.saveEvents(mappedEvents, { transactional: true, validateEvents: false });
  }

  /**
   * Планирование сохранения событий после коммита
   */
  private schedulePostCommitEventSave(events: ResearchDomainEvent[]): void {
    // В реальном приложении здесь бы использовался event emitter или очередь
    // Для простоты используем setImmediate
    const outbox = this.outbox;
    const eventStore = this.eventStore;
    setImmediate(async () => {
      try {
        if (outbox) {
          const mappedEvents = events.map(ev => mapResearchEventToStoreEvent(ev));
          await (outbox as { saveEventsWithOutbox: (events: StoreEvent[]) => Promise<unknown> }).saveEventsWithOutbox(mappedEvents);
        } else if (eventStore) {
          const mappedEvents = events.map(ev => mapResearchEventToStoreEvent(ev));
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

  /**
   * Резолвинг Outbox с явной ошибкой при отсутствии
   */
  // resolveOutbox() removed - now using constructor-injected this.outbox (TASK-002)

  async delete(id: ResearchReportId): Promise<RepositoryResult<void>> {
    try {
      // Soft delete - помечаем как удаленную
      const result = await this.db.query(
        'UPDATE research_reports SET status = $1 WHERE id = $2',
        ['deleted', id.toValue()]
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
        error: RepositoryError.connectionError('Failed to delete research report', error as Error)
      };
    }
  }

  async exists(id: ResearchReportId): Promise<boolean> {
    try {
      const result = await this.db.query(
        'SELECT 1 FROM research_reports WHERE id = $1 AND status != $2',
        [id.toValue(), 'deleted']
      );
      return result.rows.length > 0;

    } catch (error) {
      console.error('Failed to check research report existence:', error);
      return false;
    }
  }

  async count(options?: Omit<FindResearchReportsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number> {
    return this.getTotalCount(options || {});
  }

  // Приватные методы для маппинга данных
  private hydrateFromDb(dbRow: {
    id: string;
    topic: string;
    status: string;
    created_by: string;
    created_at: string;
    completed_at?: string;
    version?: number;
  }): ResearchReport {
    // Восстановление агрегата из упрощенной read‑model записи
    // Для полного восстановления состояния нужно использовать rehydrate с событиями
    const createdAt = new Date(dbRow.created_at);
    const completedAt = dbRow.completed_at ? new Date(dbRow.completed_at) : undefined;

    // Props not used - restoreFromHistory handles reconstitution
    // This read-model hydrate is simplified; full reconstitution uses event replay

    // Для полного восстановления состояния используйте rehydrate с событиями
    return ResearchReport.restoreFromHistory(
      ResearchReportId.fromString(dbRow.id),
      [] // Пустой массив событий - read-model не содержит полного состояния
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dehydrateToDb(report: any): {
    id: string;
    topic: string;
    status: string;
    created_by: string;
    version: number;
    created_at: Date;
    completed_at: Date | null;
  } {
    return {
      id: report.id.toValue(),
      topic: report.topic.value,
      status: report.status,
      created_by: report.props.createdBy.toValue(),
      version: report.version,
      created_at: report.props.createdAt,
      completed_at: report.props.completedAt || null,
    };
  }

  private async getTotalCount(options: Omit<FindResearchReportsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number> {
    let query = 'SELECT COUNT(*) as total FROM research_reports WHERE status != $1';
    const params: unknown[] = ['deleted'];
    let paramIndex = 2;

    if (options.researcherId) {
      query += ` AND created_by = $${paramIndex}`;
      params.push(options.researcherId);
      paramIndex++;
    }

    if (options.status) {
      query += ` AND status = $${paramIndex}`;
      params.push(options.status);
      paramIndex++;
    }

    if (options.topicKeywords && options.topicKeywords.length > 0) {
      const keywordConditions = options.topicKeywords.map((_, idx) => `$${paramIndex + idx} = ANY(string_to_array(topic, ' '))`).join(' OR ');
      query += ` AND (${keywordConditions})`;
      params.push(...options.topicKeywords);
      paramIndex += options.topicKeywords.length;
    }

    const result = await this.db.query<{ total: string }>(query, params);
    return parseInt(result.rows[0].total, 10);
  }

  async rehydrate(id: ResearchReportId): Promise<RepositoryResult<ResearchReport>> {
    if (!this.eventStore) {
      return {
        success: false,
        error: RepositoryError.connectionError(
          'IEventStore is not available for rehydration',
          new Error('IEventStore not injected'),
        ),
      };
    }
    try {
      const aggregateId = id.toValue();

      // One store round trip when the store can return the snapshot and the tail together.
      const { snapshot, events: tailOrAll } = await this.loadAggregate(aggregateId);

      if (!snapshot) {
        // Fallback: старый путь — полная история событий
        const events = tailOrAll;

        if (events.length === 0) {
          return {
            success: false,
            error: RepositoryError.notFound(id.toValue()),
          };
        }

        const domainEvents: ResearchDomainEvent[] = events.map((e) => ({
          ...e,
          type: mapStoreEventTypeToResearchEventType(e.type),
        })) as ResearchDomainEvent[];

        const report = ResearchReport.restoreFromHistory(id, domainEvents);
        return { success: true, data: report };
      }

      // 2. Восстанавливаем агрегат из snapshot‑состояния
      const reportFromSnapshot = ResearchReport.restoreFromSnapshot(snapshot.data);

      // 3. Догружаем «хвост» событий после snapshot.version
      const tailEvents = tailOrAll;
      if (tailEvents.length > 0) {
        const domainTailEvents: ResearchDomainEvent[] = tailEvents.map((e) => ({
          ...e,
          type: mapStoreEventTypeToResearchEventType(e.type),
        })) as ResearchDomainEvent[];

        for (const event of domainTailEvents) {
          reportFromSnapshot.applyEvent(event);
        }
        reportFromSnapshot.clearEvents();
      }

      return { success: true, data: reportFromSnapshot };
    } catch (error) {
      return {
        success: false,
        error: RepositoryError.connectionError(
          'Failed to rehydrate research report',
          error instanceof Error ? error : new Error('Unknown error'),
        ),
      };
    }
  }

  private async loadAggregate(aggregateId: string): Promise<{
    snapshot: Awaited<ReturnType<IEventStore['getSnapshot']>>;
    events: StoreEvent[];
  }> {
    const eventStore = this.eventStore;
    if (!eventStore) {
      throw new Error('IEventStore is not available for rehydration');
    }
    const store = eventStore as IEventStore & {
      loadAggregate?: (id: string) => Promise<{
        snapshot: Awaited<ReturnType<IEventStore['getSnapshot']>>;
        events: StoreEvent[];
      }>;
    };
    if (typeof store.loadAggregate === 'function') {
      return store.loadAggregate(aggregateId);
    }
    const snapshot = await eventStore.getSnapshot(aggregateId);
    const events = await eventStore.getEvents(aggregateId, snapshot ? snapshot.version + 1 : 1);
    return { snapshot, events };
  }

  /**
   * Автоматическое создание snapshot состояния агрегата.
   *
   * Snapshot сохраняется каждые SNAPSHOT_FREQUENCY событий (по версии агрегата),
   * где версия — aggregateVersion последнего применённого события.
   * Ошибки при создании snapshot не считаются фатальными для save().
   */
  private async maybeCreateSnapshot(report: ResearchReport): Promise<void> {
    const lastEventVersion = report.version - 1;
    if (lastEventVersion <= 0) {
      return;
    }
    if (lastEventVersion % PostgresResearchReportRepository.SNAPSHOT_FREQUENCY !== 0) {
      return;
    }

    try {
      if (!this.eventStore) {
        console.warn('PostgresResearchReportRepository: IEventStore not available for snapshot creation');
        return;
      }
      const aggregateId = report.id.toValue();
      const snapshotState = report.serialize();
      await this.eventStore.saveSnapshot(aggregateId, lastEventVersion, snapshotState);
    } catch (error) {
      // Snapshot — оптимизация восстановления, поэтому логируем и продолжаем.
      // В проде здесь можно добавить structured logging.
       
      console.warn(
        'PostgresResearchReportRepository: failed to create snapshot for report',
        error,
      );
    }
  }
}