import { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import {
  IUnitOfWork,
  ITransaction,
  TransactionInfo,
  TransactionOptions as UowTransactionOptions,
} from '../../domain/persistence/IUnitOfWork';
import type { TransactionOptions as DbTransactionOptions } from '../../domain/persistence/IDatabaseConnection';
// container import removed - TASK-002: using constructor injection instead
import type { IOutbox } from '../../domain/events/outbox.interface';
import type { IEventStore } from '../../domain/events/event-store.interface';
// PostgreSQLOutbox import removed to break circular dependency
import { requireActivePgClient } from './PgClientContext';
import { AsyncLocalStorage } from 'async_hooks';
import { IdGenerator } from '../../core/utils/IdGenerator';
import type { PoolClient } from 'pg';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import { IDisposable } from '../../core/di/types';

/**
 * State of the Unit of Work stored in AsyncLocalStorage.
 * Ensures isolation between concurrent requests even if UoW instance is shared.
 */
interface UowState {
  transactionStack: Array<{
    transaction: PostgresTransaction;
    trackedStartIndex: number;
    /** The async branch ID that owns this transaction level */
    ownerId: string;
  }>;
  tracked: Array<{
    object: { id: { toString(): string } };
    events: DomainEvent[];
  }>;
}

interface TransactionalOutbox extends IOutbox {
  saveEventsWithOutboxInTxClient(client: PoolClient, events: DomainEvent[]): Promise<void>;
}

function isTransactionalOutbox(value: IOutbox | undefined): value is TransactionalOutbox {
  return !!value && typeof (value as TransactionalOutbox).saveEventsWithOutboxInTxClient === 'function';
}

/**
 * PostgresUnitOfWork
 * Infrastructure-реализация IUnitOfWork поверх IDatabaseConnection и PostgreSQL.
 *
 * Цели:
 * - Единая транзакционная граница для:
 *   - изменений агрегатов через репозитории
 *   - записи доменных событий в Event Store / Outbox
 * - Использование AsyncLocalStorage (getActivePgClient) для проброса tx-клиента.
 * - Не нарушать существующую модель: репозитории продолжают использовать IDatabaseConnection,
 *   но внутри UoW они работают на общем транзакционном клиенте.
 *
 * Важно:
 * - Регистрируется в DI как 'IUnitOfWork' из bootstrap.
 * - Application слой использует executeInTransaction для критичных сценариев.
 */

class PostgresTransaction implements ITransaction {
  public readonly transactionId: string;
  public readonly startedAt: Date;
  public completedAt?: Date;
  public status: TransactionInfo['status'];
  private modifiedObjectsCount = 0;
  private publishedEventsCount = 0;

  public readonly parentTransactionId?: string;

  constructor(transactionId: string, parentTransactionId?: string) {
    this.transactionId = transactionId;
    this.parentTransactionId = parentTransactionId;
    this.startedAt = new Date();
    this.status = 'active';
  }

  async commit(): Promise<void> {
    if (this.status !== 'active' && this.status !== 'pending') {
      throw new Error(`Cannot commit transaction in status=${this.status}`);
    }
    this.status = 'committed';
    this.completedAt = new Date();
  }

  async rollback(): Promise<void> {
    if (this.status === 'committed' || this.status === 'rolled_back') {
      return;
    }
    this.status = 'rolled_back';
    this.completedAt = new Date();
  }

  getInfo(): TransactionInfo {
    return {
      transactionId: this.transactionId,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      modifiedObjectsCount: this.modifiedObjectsCount,
      publishedEventsCount: this.publishedEventsCount,
    };
  }

  registerModification(): void {
    this.modifiedObjectsCount += 1;
  }

  registerPublishedEvents(count: number): void {
    this.publishedEventsCount += count;
  }
}


export class PostgresUnitOfWork implements IUnitOfWork, IDisposable {
  private static readonly storage = new AsyncLocalStorage<UowState>();
  /** 
   * Local ALS to track the active execution branch within the current async flow.
   * Used to distinguish between nested and parallel calls.
   */
  private readonly branchTracker = new AsyncLocalStorage<string>();

  private readonly db: IDatabaseConnection;
  private readonly outbox?: IOutbox;
  private readonly eventStore?: IEventStore;

  constructor(
    db: IDatabaseConnection,
    outboxInstance?: IOutbox,
    eventStoreInstance?: IEventStore,
  ) {
    // TASK-002: Dependencies must be explicitly injected, no container.resolve fallback
    this.db = db;
    this.outbox = outboxInstance;
    this.eventStore = eventStoreInstance;
  }

  /**
   * Internal helper to get or initialize the UoW state for the current async context.
   */
  private getState(): UowState {
    let state = PostgresUnitOfWork.storage.getStore();
    if (!state) {
      // If we are not in an active storage, we create a temporary one for this request's top-level.
      // However, in production, RequestContext should have already entered a storage.
      state = { transactionStack: [], tracked: [] };
      PostgresUnitOfWork.storage.enterWith(state);
    }
    return state;
  }

  private get transactionStack() {
    return this.getState().transactionStack;
  }

  private get tracked() {
    return this.getState().tracked;
  }

  async begin(_options?: UowTransactionOptions): Promise<ITransaction> {
    const topIndex = this.transactionStack.length - 1;
    const txId = IdGenerator.generateWithPrefix('tx');
    const tx = new PostgresTransaction(txId);

    // Concurrency Guard for manual begin
    const currentBranchId = this.branchTracker.getStore();
    const isParallel = topIndex >= 0 && currentBranchId === undefined;

    if (isParallel) {
      const activeTxId = this.transactionStack[topIndex].transaction.transactionId;
      throw new Error(
        `Parallel transaction detected (manual begin): transaction ${txId} attempted to start while ${activeTxId} is still active on the same UnitOfWork.`
      );
    }

    this.transactionStack.push({
      transaction: tx,
      trackedStartIndex: this.tracked.length,
      ownerId: txId, // Initial manual begin also establishes an ownerId
    });

    // При ручном begin() статус помечаем как pending до фактической работы в executeInTransaction.
    tx.status = 'pending';

    return tx;
  }

  async executeInTransaction<T>(
    operation: (transaction: ITransaction) => Promise<T>,
    options?: UowTransactionOptions,
  ): Promise<T> {
    // EV5: Check for nesting strategy violations
    const topIndex = this.transactionStack.length - 1;
    if (options?.nestingStrategy === 'NEVER' && topIndex >= 0) {
      throw new Error(
        `Nesting prohibited: active transaction ${this.transactionStack[topIndex].transaction.transactionId} already exists.`,
      );
    }

    const parentTxId =
      topIndex >= 0
        ? this.transactionStack[topIndex].transaction.transactionId
        : undefined;
    const txId = IdGenerator.generateWithPrefix('tx');
    const tx = new PostgresTransaction(txId, parentTxId);

    // Concurrency Guard: Detect parallel execution on same instance
    const currentBranchId = this.branchTracker.getStore();
    const isParallel = topIndex >= 0 && currentBranchId === undefined;
    
    if (isParallel) {
      const activeTxId = this.transactionStack[topIndex].transaction.transactionId;
      throw new Error(
        `Parallel transaction detected: transaction ${txId} attempted to start while ${activeTxId} is still active on the same UnitOfWork. ` +
        `Parallel transactional execution on a single database connection/UnitOfWork is prohibited. ` +
        `Use separate UnitOfWork instances or sequential execution (await).`
      );
    }

    const scope = {
      transaction: tx,
      trackedStartIndex: this.tracked.length,
      ownerId: txId, // Use txId as the branch identifier
    };

    return await this.branchTracker.run(txId, async () => {
      this.transactionStack.push(scope);

      const dbOptions = this.mapToDbTransactionOptions(options);

      try {
        const result = await this.db.transaction<T>(
          async () => {
            // Гарантируем наличие активного PostgreSQL клиента для всей транзакции.
            const client: PoolClient = requireActivePgClient(
              'PostgresUnitOfWork.executeInTransaction',
            );

            const value = await operation(tx);

            // После доменного кода — сброс событий только текущего scope в Outbox/EventStore.
            await this.flushTrackedEventsForScope(client, scope.trackedStartIndex);

            return value;
          },
          dbOptions,
        );

        await tx.commit();
        this.transactionStack.pop();
        return result;
      } catch (error) {
        await tx.rollback();
        this.truncateTrackedTo(scope.trackedStartIndex);
        this.transactionStack.pop();
        throw error;
      }
    });
  }

  getCurrentTransaction(): ITransaction | null {
    const topIndex = this.transactionStack.length - 1;
    if (topIndex < 0) {
      return null;
    }
    const scope = this.transactionStack[topIndex];
    if (!scope) {
      return null;
    }
    return scope.transaction;
  }

  registerChanged(
    object: { id: { toString(): string } },
    events: DomainEvent[],
  ): void {
    this.tracked.push({ object, events });

    const topIndex = this.transactionStack.length - 1;
    if (topIndex < 0) {
      return;
    }

    const scope = this.transactionStack[topIndex];
    scope.transaction.registerModification();
    scope.transaction.registerPublishedEvents(events.length);
  }

  registerNew(
    object: { id: { toString(): string } },
    events: DomainEvent[],
  ): void {
    this.registerChanged(object, events);
  }

  registerDeleted(
    object: { id: { toString(): string } },
    events: DomainEvent[],
  ): void {
    this.registerChanged(object, events);
  }

  getChangedObjects(): Array<{
    object: { id: { toString(): string } };
    events: DomainEvent[];
  }> {
    return [...this.tracked];
  }

  clear(): void {
    this.tracked.splice(0, this.tracked.length);
  }

  async isHealthy(): Promise<boolean> {
    try {
      return await this.db.isConnected();
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.dispose();
  }

  dispose(): void {
    this.clear();
    // Clear the stack for the CURRENT ALS context
    this.transactionStack.splice(0, this.transactionStack.length);
  }

  private truncateTrackedTo(index: number): void {
    if (index <= 0) {
      this.tracked.splice(0, this.tracked.length);
      return;
    }
    if (index < this.tracked.length) {
      this.tracked.splice(index, this.tracked.length - index);
    }
  }

  /**
   * Сохранить накопленные события текущего scope через Outbox (предпочтительно) или EventStore.
   * Вызывается внутри активной транзакции, где есть PoolClient, полученный из PostgresAdapter.
   */
  private async flushTrackedEventsForScope(
    client: PoolClient,
    trackedStartIndex: number,
  ): Promise<void> {
    if (trackedStartIndex >= this.tracked.length) {
      return;
    }

    const scopeEntries = this.tracked.slice(trackedStartIndex);
    const allEvents: DomainEvent[] = scopeEntries.flatMap((entry) => entry.events);

    if (allEvents.length === 0) {
      this.truncateTrackedTo(trackedStartIndex);
      return;
    }

    if (isTransactionalOutbox(this.outbox)) {
      await this.outbox.saveEventsWithOutboxInTxClient(client, allEvents);
    } else if (this.eventStore) {
      await this.eventStore.saveEvents(allEvents, {
        transactional: true,
        validateEvents: false,
      });
    } else {
      // В проде отсутствие Outbox/EventStore при наличии UoW — конфигурационная ошибка.
      throw new Error(
        'PostgresUnitOfWork: no Outbox/EventStore configured for flushing events',
      );
    }

    this.truncateTrackedTo(trackedStartIndex);
  }

  private mapToDbTransactionOptions(
    options?: UowTransactionOptions,
  ): DbTransactionOptions | undefined {
    if (!options) {
      return undefined;
    }

    let isolationLevel: DbTransactionOptions['isolationLevel'] | undefined;

    if (options.isolationLevel === 'read_uncommitted') {
      isolationLevel = 'READ_UNCOMMITTED';
    } else if (options.isolationLevel === 'read_committed') {
      isolationLevel = 'READ_COMMITTED';
    } else if (options.isolationLevel === 'repeatable_read') {
      isolationLevel = 'REPEATABLE_READ';
    } else if (options.isolationLevel === 'serializable') {
      isolationLevel = 'SERIALIZABLE';
    }

    return {
      isolationLevel,
      timeoutMs: options.timeoutMs,
      readOnly: undefined,
    };
  }
}