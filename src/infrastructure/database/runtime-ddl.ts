import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { getRawEnv } from '../../config';

/** Runtime CREATE/ALTER stays off unless an operator sets DB_RUNTIME_DDL=true. */
export function runtimeDdlEnabled(): boolean {
  return getRawEnv().DB_RUNTIME_DDL === 'true';
}

export async function requirePublicTables(
  db: IDatabaseConnection,
  tables: readonly string[],
): Promise<void> {
  const result = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [tables],
  );
  const present = new Set(result.rows.map((row) => row.table_name));
  throwIfMissing(tables, present);
}

export async function requireQualifiedTables(
  query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ schema_name: string; table_name: string }> }>,
  qualified: readonly string[],
): Promise<void> {
  const schemas: string[] = [];
  const tables: string[] = [];
  for (const name of qualified) {
    const dot = name.indexOf('.');
    if (dot <= 0 || dot === name.length - 1) {
      throw new Error(`Schema name must be schema.table, got ${name}`);
    }
    schemas.push(name.slice(0, dot));
    tables.push(name.slice(dot + 1));
  }
  const result = await query(
    `SELECT table_schema AS schema_name, table_name
       FROM information_schema.tables
      WHERE (table_schema, table_name) IN (SELECT * FROM UNNEST($1::text[], $2::text[]))`,
    [schemas, tables],
  );
  const present = new Set(result.rows.map((row) => `${row.schema_name}.${row.table_name}`));
  throwIfMissing(qualified, present);
}

function throwIfMissing(expected: readonly string[], present: Set<string>): void {
  const missing = expected.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`Schema is missing ${missing.join(', ')}. Apply migrations.`);
  }
}
