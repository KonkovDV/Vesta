import { IUserRepository } from '../../../domain/identity/IUserRepository';
import { User, UserRole, UserStatus } from '../../../domain/identity/User';
import { EntityId, Timestamp } from '../../../core/types';
import { Result } from '../../../core/result';
import { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  tenant_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_login_at?: Date | string | null;
  metadata?: Record<string, unknown> | string | null;
}

function toTimestamp(value: Date | string): Timestamp {
  return Timestamp.fromString(value instanceof Date ? value.toISOString() : new Date(value).toISOString());
}

function toMetadata(value: UserRow['metadata']): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>;
  }

  return value && typeof value === 'object' ? value : undefined;
}

export class PostgresUserRepository implements IUserRepository {
  constructor(private readonly db: IDatabaseConnection) {}

  async save(user: User): Promise<Result<void>> {
    try {
      const sql = `
        INSERT INTO identity.users (id, email, name, role, status, tenant_id, created_at, updated_at, last_login_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at,
          last_login_at = EXCLUDED.last_login_at,
          metadata = EXCLUDED.metadata
      `;

      await this.db.query(sql, [
        user.id.toValue(),
        user.email,
        user.name,
        user.role,
        user.status,
        user.tenantId.toValue(),
        user.createdAt.toDate(),
        user.updatedAt.toDate(),
        user.lastLoginAt ? user.lastLoginAt.toDate() : null,
        user.metadata ? JSON.stringify(user.metadata) : null,
      ]);

      return Result.ok();
    } catch (error) {
      return Result.fail(`Failed to save user: ${String(error)}`);
    }
  }

  async findById(id: EntityId | string): Promise<Result<User>> {
    try {
      const idStr = typeof id === 'string' ? id : id.toValue();
      const sql = `SELECT * FROM identity.users WHERE id = $1`;
      
      const result = await this.db.queryOne<UserRow>(sql, [idStr]);
      if (!result) {
        return Result.fail(`User not found: ${idStr}`);
      }

      return this.mapToDomain(result);
    } catch (error) {
      return Result.fail(`Failed to find user: ${String(error)}`);
    }
  }

  async findByEmail(email: string): Promise<Result<User>> {
    try {
      const sql = `SELECT * FROM identity.users WHERE email = $1`;
      
      const result = await this.db.queryOne<UserRow>(sql, [email]);
      if (!result) {
        return Result.fail(`User not found with email: ${email}`);
      }

      return this.mapToDomain(result);
    } catch (error) {
      return Result.fail(`Failed to find user by email: ${String(error)}`);
    }
  }
  
  async exists(email: string): Promise<Result<boolean>> {
      try {
          const sql = `SELECT 1 FROM identity.users WHERE email = $1`;
          const result = await this.db.queryOne(sql, [email]);
          return Result.ok(!!result);
      } catch (error) {
          return Result.fail(`Failed to check existence: ${String(error)}`);
      }
  }

  private mapToDomain(row: UserRow): Result<User> {
    try {
        const props = {
            email: row.email,
            name: row.name,
            role: row.role,
            status: row.status,
            tenantId: EntityId.fromString(row.tenant_id),
            createdAt: toTimestamp(row.created_at),
            updatedAt: toTimestamp(row.updated_at),
            lastLoginAt: row.last_login_at ? toTimestamp(row.last_login_at) : undefined,
            metadata: toMetadata(row.metadata),
        };

        const user = User.reconstitute(props, EntityId.fromString(row.id));
        return Result.ok(user);
    } catch (e) {
        return Result.fail(`Mapping error: ${String(e)}`);
    }
  }
}
