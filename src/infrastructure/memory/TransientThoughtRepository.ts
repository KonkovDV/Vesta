
import { PostgresGenericRepository } from '../database/PostgresGenericRepository';
import { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';

export interface TransientThought {
  id: string;
  content: string;
  created_at: Date;
  expires_at: Date;
}

export class TransientThoughtRepository extends PostgresGenericRepository<TransientThought> {
  constructor(db: IDatabaseConnection) {
    super(db, 'singularity.thought_transient', ['id', 'content', 'created_at', 'expires_at']);
  }

  async deleteExpired(): Promise<number> {
    const sql = `
      DELETE FROM ${this.tableName}
      WHERE expires_at < NOW()
    `;
    return this.db.execute(sql);
  }
}
