import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import type {
  IApiKeyRepository,
  StoredApiKey,
  CreateApiKeyParams,
} from '../../domain/auth/IApiKeyRepository';
import { PostgresGenericRepository } from './PostgresGenericRepository';

/**
 * PostgreSQL реализация IApiKeyRepository.
 * Layer: Infrastructure
 *
 * Хранит только хэши API-ключей (без сырых значений).
 * Таблица ожидается в следующем виде (см. TASK-007):
 *
 * CREATE TABLE api_keys (
 *   id UUID PRIMARY KEY,
 *   prefix VARCHAR(10) NOT NULL,
 *   hash VARCHAR(255) NOT NULL,
 *   owner_id VARCHAR(255) NOT NULL,
 *   scopes TEXT[] DEFAULT '{}',
 *   expires_at TIMESTAMPTZ,
 *   created_at TIMESTAMPTZ DEFAULT NOW(),
 *   revoked_at TIMESTAMPTZ
 * );
 * CREATE INDEX idx_api_keys_prefix ON api_keys(prefix);
 */

interface DbApiKeyRow {
  id: string;
  prefix: string;
  hash: string;
  owner_id: string;
  tenant_id: string | null;
  scopes: string[] | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

export class PostgresApiKeyRepository implements IApiKeyRepository {
  private readonly db: IDatabaseConnection;
  private readonly genericRepo: PostgresGenericRepository<DbApiKeyRow>;

  constructor(db: IDatabaseConnection) {
    this.db = db;
    this.genericRepo = new PostgresGenericRepository<DbApiKeyRow>(
      db, 
      'api_keys', 
      ['id', 'prefix', 'hash', 'owner_id', 'tenant_id', 'scopes', 'expires_at', 'created_at', 'revoked_at']
    );
  }

  async create(params: CreateApiKeyParams): Promise<StoredApiKey> {
    const scopesValue = params.scopes ? [...params.scopes] : [];
    const expiresAtValue = params.expiresAt ?? null;
    const now = new Date();

    const row: DbApiKeyRow = {
      id: params.id,
      prefix: params.prefix,
      hash: params.hash,
      owner_id: params.ownerId,
      tenant_id: params.tenantId ?? null,
      scopes: scopesValue,
      expires_at: expiresAtValue,
      created_at: now,
      revoked_at: null,
    };

    const createdRow = await this.genericRepo.create(row);
    return this.mapRow(createdRow);
  }

  async findByPrefix(prefix: string): Promise<StoredApiKey | null> {
    // Fallback to raw DB query for specific sorting logic
    const row = await this.db.queryOne<DbApiKeyRow>(
      `SELECT * FROM api_keys WHERE prefix = $1 ORDER BY created_at DESC LIMIT 1`,
      [prefix]
    );

    if (!row) return null;
    return this.mapRow(row);
  }

  async revokeById(id: string, revokedAt: Date): Promise<void> {
    await this.genericRepo.update(id, { revoked_at: revokedAt });
  }

  async findByOwnerId(ownerId: string): Promise<readonly StoredApiKey[]> {
    const result = await this.db.query<DbApiKeyRow>(
      `SELECT * FROM api_keys WHERE owner_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [ownerId]
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async revokeExpired(): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE api_keys SET revoked_at = NOW() WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND revoked_at IS NULL RETURNING id`,
      []
    );
    return result.rowCount;
  }

  private mapRow(row: DbApiKeyRow): StoredApiKey {
    // Same mapping logic
    const createdAtDate = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    const expiresAtDate = row.expires_at ? (row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)) : null;
    const revokedAtDate = row.revoked_at ? (row.revoked_at instanceof Date ? row.revoked_at : new Date(row.revoked_at)) : null;
    const scopesValue = row.scopes ?? [];

    return {
      id: row.id,
      prefix: row.prefix,
      hash: row.hash,
      ownerId: row.owner_id,
      tenantId: row.tenant_id,
      scopes: scopesValue,
      expiresAt: expiresAtDate,
      createdAt: createdAtDate,
      revokedAt: revokedAtDate,
    };
  }
}