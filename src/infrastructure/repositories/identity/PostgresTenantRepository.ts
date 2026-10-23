import { ITenantRepository } from '../../../domain/identity/ITenantRepository';
import { Tenant, TenantStatus, TenantTier } from '../../../domain/identity/Tenant';
import { EntityId, Timestamp } from '../../../core/types';
import { Result } from '../../../core/result';
import { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';

interface TenantRow {
  id: string;
  name: string;
  status: TenantStatus;
  tier: TenantTier;
  settings?: Record<string, unknown> | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toTimestamp(value: Date | string): Timestamp {
  return Timestamp.fromString(value instanceof Date ? value.toISOString() : new Date(value).toISOString());
}

function toSettings(value: TenantRow['settings']): Record<string, unknown> {
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>;
  }

  return value && typeof value === 'object' ? value : {};
}

export class PostgresTenantRepository implements ITenantRepository {
  constructor(private readonly db: IDatabaseConnection) {}

  async save(tenant: Tenant): Promise<Result<void>> {
    try {
      const sql = `
        INSERT INTO identity.tenants (id, name, status, tier, settings, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          tier = EXCLUDED.tier,
          settings = EXCLUDED.settings,
          updated_at = EXCLUDED.updated_at
      `;

      await this.db.query(sql, [
        tenant.id.toValue(),
        tenant.name,
        tenant.status,
        tenant.tier,
        JSON.stringify(tenant.settings),
        tenant.createdAt.toDate(),
        tenant.updatedAt.toDate(),
      ]);

      return Result.ok();
    } catch (error) {
      return Result.fail(`Failed to save tenant: ${String(error)}`);
    }
  }

  async delete(id: EntityId | string): Promise<Result<void>> {
    try {
      const idStr = typeof id === 'string' ? id : id.toValue();
      await this.db.query(`DELETE FROM identity.tenants WHERE id = $1`, [idStr]);
      return Result.ok();
    } catch (error) {
      return Result.fail(`Failed to delete tenant: ${String(error)}`);
    }
  }

  async findById(id: EntityId | string): Promise<Result<Tenant>> {
    try {
      const idStr = typeof id === 'string' ? id : id.toValue();
      const sql = `SELECT * FROM identity.tenants WHERE id = $1`;
      
      const result = await this.db.queryOne<TenantRow>(sql, [idStr]);
      if (!result) {
        return Result.fail(`Tenant not found: ${idStr}`);
      }

      return this.mapToDomain(result);
    } catch (error) {
      return Result.fail(`Failed to find tenant: ${String(error)}`);
    }
  }

  async findByName(name: string): Promise<Result<Tenant>> {
    try {
      const sql = `SELECT * FROM identity.tenants WHERE name = $1`;
      
      const result = await this.db.queryOne<TenantRow>(sql, [name]);
      if (!result) {
        return Result.fail(`Tenant not found with name: ${name}`);
      }

      return this.mapToDomain(result);
    } catch (error) {
      return Result.fail(`Failed to find tenant by name: ${String(error)}`);
    }
  }

  private mapToDomain(row: TenantRow): Result<Tenant> {
    try {
        const props = {
            name: row.name,
            status: row.status,
            tier: row.tier,
            settings: toSettings(row.settings),
            createdAt: toTimestamp(row.created_at),
            updatedAt: toTimestamp(row.updated_at),
        };

        const tenant = Tenant.reconstitute(props, EntityId.fromString(row.id));
        
        return Result.ok(tenant);
    } catch (e) {
        return Result.fail(`Mapping error: ${String(e)}`);
    }
  }
}
