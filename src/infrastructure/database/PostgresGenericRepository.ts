/**
 * PostgresGenericRepository - Base Generic Repository for PostgreSQL
 * Layer: Infrastructure
 *
 * Implements IGenericRepository using IDatabaseConnection.
 * Provides safe, parameterized SQL generation for standard CRUD operations.
 *
 * @template T - The entity type (must interface with the DB table structure).
 */
import { IGenericRepository } from '../../domain/persistence/IGenericRepository';
import { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

export class PostgresGenericRepository<T> implements IGenericRepository<T> {
  /**
   * @param db - Database connection (injected).
   * @param tableName - The name of the database table.
   * @param fields - List of column names to select/insert/update (whitelist for security).
   */
  constructor(
    protected readonly db: IDatabaseConnection,
    protected readonly tableName: string,
    protected readonly fields: string[],
    private readonly logger?: IStructuredLogger,
  ) {
    if (fields.length === 0) {
      throw new Error('Fields list cannot be empty');
    }
    const safeIdentifier = /^[a-z0-9_.]+$/i;
    if (!safeIdentifier.test(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    for (const field of fields) {
      if (!safeIdentifier.test(field)) {
        throw new Error(`Invalid field name: ${field}`);
      }
    }
  }

  async findById(id: string): Promise<T | null> {
    const columns = this.fields.join(', ');
    const sql = `SELECT ${columns} FROM ${this.tableName} WHERE id = $1`;
    return this.db.queryOne<T>(sql, [id]);
  }

  async findAll(filter?: Partial<T>): Promise<T[]> {
    const columns = this.fields.join(', ');
    
    if (!filter || Object.keys(filter).length === 0) {
      const sql = `SELECT ${columns} FROM ${this.tableName}`;
      const result = await this.db.query<T>(sql);
      return result.rows;
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(filter)) {
      if (this.fields.includes(key) && value !== undefined) {
        conditions.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (conditions.length === 0) {
       // Filter keys provided but none matched whitelist. 
       // Returning ALL records is unsafe. Return empty list or throw.
       // Decision: Return empty list to prevent leak, log warning.
       this.logger?.warn(`[PostgresGenericRepository] Filter provided but no valid fields matched whitelist in ${this.tableName}`, { fields: Object.keys(filter) });
       return [];
    }

    const whereClause = conditions.join(' AND ');
    const sql = `SELECT ${columns} FROM ${this.tableName} WHERE ${whereClause}`;
    const result = await this.db.query<T>(sql, values);
    return result.rows;
  }

  async create(entity: T): Promise<T> {
    const data = entity as Record<string, unknown>;
    const columns: string[] = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const field of this.fields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        columns.push(field);
        // PG driver throws on "undefined". Convert to null.
        const val = data[field];
        values.push(val === undefined ? null : val);
        placeholders.push(`$${idx}`);
        idx++;
      }
    }

    if (columns.length === 0) {
      throw new Error(`No valid fields provided for creation in ${this.tableName}`);
    }

    const sql = `
      INSERT INTO ${this.tableName} (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING ${this.fields.join(', ')}
    `;

    const result = await this.db.queryOne<T>(sql, values);
    if (!result) {
      throw new Error(`Failed to create entity in ${this.tableName}`);
    }
    return result;
  }

  async update(id: string, entity: Partial<T>): Promise<T> {
    const data = entity as Record<string, unknown>;
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (this.fields.includes(key) && key !== 'id') { // Prevent updating ID
        updates.push(`${key} = $${idx}`);
        // PG handling for undefined
        const val = value;
        values.push(val === undefined ? null : val);
        idx++;
      }
    }

    if (updates.length === 0) {
       // No valid updates, return existing
       const existing = await this.findById(id);
       if (!existing) throw new Error(`Entity ${id} not found in ${this.tableName}`);
       return existing;
    }

    values.push(id);
    const sql = `
      UPDATE ${this.tableName}
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING ${this.fields.join(', ')}
    `;

    const result = await this.db.queryOne<T>(sql, values);
    if (!result) {
      // In case of concurrency or if ID doesn't exist
      throw new Error(`Failed to update entity ${id} in ${this.tableName} (not found)`);
    }
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const sql = `DELETE FROM ${this.tableName} WHERE id = $1`;
    const count = await this.db.execute(sql, [id]);
    return count > 0;
  }
}
