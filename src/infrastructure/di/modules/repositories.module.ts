/**
 * Repository DI module.
 * Выносит регистрацию инфраструктурных репозиториев из bootstrap.ts.
 */
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import type { IOutbox } from '../../../domain/events/outbox.interface';
import type { IEventStore } from '../../../domain/events/event-store.interface';
import type {
  IApiKeyRepository,
  StoredApiKey,
  CreateApiKeyParams,
} from '../../../domain/auth/IApiKeyRepository';
import { PostgresConversationRepository } from '../../database/PostgresConversationRepository';
import { PostgresResearchReportRepository } from '../../database/PostgresResearchReportRepository';
import { PostgresApiKeyRepository } from '../../database/PostgresApiKeyRepository';
import { PostgresProcessedEventStore } from '../../events/PostgresProcessedEventStore';
import { PostgresUserRepository } from '../../repositories/identity/PostgresUserRepository';
import { PostgresTenantRepository } from '../../repositories/identity/PostgresTenantRepository';
import { InMemoryTokenomicsController } from '../../finops/InMemoryTokenomicsController';
import { DurableTokenomicsDecorator, type ISpendStateStore } from '../../finops/DurableTokenomicsDecorator';
import { PostgresSpendStateStore } from '../../finops/PostgresSpendStateStore';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';

const log = getBootstrapLogger('repositories');

export function registerRepositoryServices(useInMemory = false): void {
  try {
    container.register('IConversationRepository', () => {
      if (useInMemory) {
        return {
          findById: async () => null,
          save: async () => undefined,
        };
      }
      const db = container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
      // TASK-002: Explicitly inject optional dependencies
      const outbox = container.isRegistered(DI_TOKENS.IOutbox) 
        ? container.resolve<IOutbox>(DI_TOKENS.IOutbox) 
        : undefined;
      const eventStore = container.isRegistered(DI_TOKENS.IEventStore) 
        ? container.resolve<IEventStore>(DI_TOKENS.IEventStore) 
        : undefined;
      return new PostgresConversationRepository(db, outbox, eventStore);
    }, {
      lifecycle: useInMemory ? 'transient' : 'singleton',
      tags: [useInMemory ? 'memory' : 'postgresql', 'repository', 'conversation'],
      description: useInMemory ? 'In-memory Conversation repository' : 'PostgreSQL Conversation repository',
    });

    container.register('IResearchReportRepository', () => {
      if (useInMemory) {
        return {
          findById: async () => null,
          save: async () => undefined,
        };
      }
      const db = container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
      // TASK-002: Explicitly inject optional dependencies
      const outbox = container.isRegistered(DI_TOKENS.IOutbox) 
        ? container.resolve<IOutbox>(DI_TOKENS.IOutbox) 
        : undefined;
      const eventStore = container.isRegistered(DI_TOKENS.IEventStore) 
        ? container.resolve<IEventStore>(DI_TOKENS.IEventStore) 
        : undefined;
      return new PostgresResearchReportRepository(db, outbox, eventStore);
    }, {
      lifecycle: useInMemory ? 'transient' : 'singleton',
      tags: [useInMemory ? 'memory' : 'postgresql', 'repository', 'research-report'],
      description: useInMemory ? 'In-memory ResearchReport repository' : 'PostgreSQL ResearchReport repository',
    });

    container.register('IApiKeyRepository', () => {
      if (useInMemory) {
        const items = new Map<string, StoredApiKey>();
        const repository: IApiKeyRepository = {
          async create(params: CreateApiKeyParams): Promise<StoredApiKey> {
            const createdAt = new Date();
            const stored: StoredApiKey = {
              id: params.id,
              prefix: params.prefix,
              hash: params.hash,
              ownerId: params.ownerId,
              tenantId: params.tenantId ?? null,
              scopes: params.scopes ?? [],
              expiresAt: params.expiresAt ?? null,
              createdAt,
              revokedAt: undefined,
            };
            items.set(stored.id, stored);
            return stored;
          },
          async findByPrefix(prefix: string): Promise<StoredApiKey | null> {
            const candidates = Array.from(items.values()).filter((value) => value.prefix === prefix);
            if (candidates.length === 0) {
              return null;
            }
            return candidates.reduce((latest, candidate) =>
              candidate.createdAt.getTime() > latest.createdAt.getTime() ? candidate : latest,
            candidates[0]);
          },
          async findByOwnerId(ownerId: string): Promise<readonly StoredApiKey[]> {
            return Array.from(items.values())
              .filter((value) => value.ownerId === ownerId && !value.revokedAt)
              .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
          },
          async revokeById(id: string, revokedAt: Date): Promise<void> {
            const existing = items.get(id);
            if (!existing) {
              return;
            }
            items.set(id, {
              ...existing,
              revokedAt,
            });
          },
          async revokeExpired(): Promise<number> {
            const now = new Date();
            let count = 0;
            for (const [id, key] of items) {
              if (key.expiresAt && key.expiresAt < now && !key.revokedAt) {
                items.set(id, { ...key, revokedAt: now });
                count++;
              }
            }
            return count;
          },
        };
        return repository;
      }

      const db = container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
      return new PostgresApiKeyRepository(db);
    }, {
      lifecycle: useInMemory ? 'transient' : 'singleton',
      tags: [useInMemory ? 'memory' : 'postgresql', 'repository', 'api-key'],
      description: useInMemory ? 'In-memory API key repository' : 'PostgreSQL API key repository',
    });

    if (!useInMemory) {
      container.register(
        DI_TOKENS.IProcessedEventStore,
        () =>
          new PostgresProcessedEventStore(
            container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection),
          ),
        {
          lifecycle: 'singleton',
          tags: ['postgresql', 'events', 'idempotency'],
          description: 'PostgreSQL consumer-side dedup (processed_events)',
        },
      );

      container.register(
        DI_TOKENS.IUserRepository,
        () => new PostgresUserRepository(container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection)),
        {
          lifecycle: 'singleton',
          tags: ['postgresql', 'repository', 'identity'],
          description: 'PostgreSQL user repository (identity.users)',
        },
      );

      container.register(
        DI_TOKENS.ITenantRepository,
        () => new PostgresTenantRepository(container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection)),
        {
          lifecycle: 'singleton',
          tags: ['postgresql', 'repository', 'identity'],
          description: 'PostgreSQL tenant repository (identity.tenants)',
        },
      );

      container.register(
        DI_TOKENS.ISpendStateStore,
        () => new PostgresSpendStateStore(container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection)),
        {
          lifecycle: 'singleton',
          tags: ['postgresql', 'finops', 'spend-state'],
          description: 'PostgreSQL FinOps spend-state store (finops.agent_spend_state)',
        },
      );
    }

    container.register(
      DI_TOKENS.ITokenomicsController,
      () => {
        const inner = new InMemoryTokenomicsController();
        if (useInMemory || !container.isRegistered(DI_TOKENS.ISpendStateStore)) {
          return inner;
        }
        return new DurableTokenomicsDecorator(
          inner,
          container.resolve<ISpendStateStore>(DI_TOKENS.ISpendStateStore),
        );
      },
      {
        lifecycle: 'singleton',
        tags: [useInMemory ? 'memory' : 'postgresql', 'finops', 'tokenomics'],
        description: useInMemory
          ? 'In-memory FinOps tokenomics controller'
          : 'Durable FinOps tokenomics controller (Postgres spend state)',
      },
    );

    log.info('Repository services registered');
  } catch (error) {
    log.error('Failed to register repository services', { error });
    throw error;
  }
}
