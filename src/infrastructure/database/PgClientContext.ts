/**
 * PgClientContext - AsyncLocalStorage контекст для транзакционного клиента PostgreSQL.
 * Layer: Infrastructure
 *
 * Единый источник правды для AsyncLocalStorage<{ client: PoolClient }>:
 * - используется PostgresAdapter, PostgresUnitOfWork, репозитории и Outbox/EventStore‑интеграции;
 * - зарегистрирован в DI под токеном 'PgClientContext';
 * - гарантирует, что в рамках транзакции используется один и тот же PoolClient во всех async‑ветках.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { PoolClient } from 'pg';
import { TransactionContextError } from '../../domain/errors/DomainError';

/**
 * Данные, хранимые в AsyncLocalStorage для PostgreSQL транзакций.
 */
export interface PgClientContextStore {
  client: PoolClient;
}

/**
 * Глобальный AsyncLocalStorage для транзакционного клиента PostgreSQL.
 *
 * ВАЖНО:
 * - единственный экземпляр ALS для PostgreSQL во всём приложении;
 * - экспортируется в DI как токен 'PgClientContext';
 * - PostgresAdapter.transaction() и другие инфраструктурные компоненты должны
 *   использовать именно этот экземпляр.
 */
export const pgClientContext = new AsyncLocalStorage<PgClientContextStore>();

/**
 * Получить активный транзакционный клиент PostgreSQL из контекста, если он есть.
 */
export function getActivePgClient(): PoolClient | undefined {
  const store = pgClientContext.getStore();
  return store?.client;
}

/**
 * Жёстко получить активный транзакционный клиент PostgreSQL.
 *
 * Если контекста нет, выбрасывает TransactionContextError вместо «тихого» открытия
 * нового подключения в autocommit‑режиме.
 */
export function requireActivePgClient(operation: string): PoolClient {
  const store = pgClientContext.getStore();
  if (!store || !store.client) {
    throw new TransactionContextError(
      `PostgresAdapter: no active PostgreSQL transaction client in ${operation}. ` +
        'This usually means code is running outside IDatabaseConnection.transaction() ' +
        'or AsyncLocalStorage context was lost.',
      {
        metadata: {
          adapter: 'PostgresAdapter',
          operation,
        },
      },
    );
  }
  return store.client;
}

/**
 * Выполнить callback внутри ALS‑контекста с переданным транзакционным клиентом.
 *
 * Гарантирует:
 * - единый PoolClient во всех async‑ветках (включая Promise.all);
 * - корректное пробрасывание ошибок callback наружу;
 * - отсутствие non‑null assertion/тайпкастов.
 */
export async function runWithPgClient<T>(
  client: PoolClient,
  callback: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pgClientContext.run({ client }, () => {
      callback()
        .then((value) => {
          resolve(value);
        })
        .catch((error) => {
          if (error instanceof Error) {
            reject(error);
            return;
          }
          reject(new Error(String(error)));
        });
    });
  });
}