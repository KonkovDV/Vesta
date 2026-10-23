/**
 * SQL migration runner for the kernel and for projects built on it.
 *
 * Core files run first, then each extra directory in the order given. Inside a
 * directory files run by name. `*.down.sql` files are rollbacks and never run here.
 * Migrations are idempotent (IF NOT EXISTS guards). A file whose checksum is already
 * in microphoenix_schema_migrations is skipped, so a second run does not execute it.
 * Editing an applied file is an error: add a new file instead.
 *
 * @layer Infrastructure
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** SQL that ships with the kernel. Resolves the same way from src/ and from dist/. */
export const CORE_MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

/** Serialises concurrent runners (for example several pods starting together). */
export const MIGRATION_LOCK_ID = 1337;

/** Written by the runner, not by a migration file. Same idea as flyway_schema_history. */
export const MIGRATION_LEDGER = 'microphoenix_schema_migrations';

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export interface MigrationClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export interface MigrationRunResult {
  succeeded: number;
  failed: number;
  skipped: number;
  files: string[];
}

export function listMigrationFiles(dirs: readonly string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const absolute = path.resolve(dir);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Migration directory not found: ${absolute}`);
    }
    const names = readdirSync(absolute)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort();
    for (const name of names) {
      files.push(path.join(absolute, name));
    }
  }
  return files;
}

/** Comments are not SQL. A mention of CONCURRENTLY in a comment must not change the runner. */
function withoutSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function stripLeadingComments(statement: string): string {
  const lines = statement.split('\n');
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0 || trimmed.startsWith('--')) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      while (index < lines.length && !lines[index].includes('*/')) {
        index += 1;
      }
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join('\n').trim();
}

function isConcurrentScript(sql: string): boolean {
  return /\bCONCURRENTLY\b/i.test(withoutSqlComments(sql));
}

/** A PL/pgSQL `BEGIN` inside `DO $$` is not a transaction. Only `BEGIN;` / `BEGIN WORK` counts. */
function hasOwnTransaction(sql: string): boolean {
  return /^\s*BEGIN\s*(WORK|TRANSACTION)?\s*;/im.test(withoutSqlComments(sql));
}

function ledgerRows(result: unknown): Array<{ filename: string; checksum: string }> {
  if (typeof result !== 'object' || result === null || !('rows' in result)) return [];
  const rows = result.rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is { filename: string; checksum: string } => {
    return typeof row === 'object' && row !== null
      && typeof (row as { filename?: unknown }).filename === 'string'
      && typeof (row as { checksum?: unknown }).checksum === 'string';
  });
}

function splitConcurrentStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => stripLeadingComments(statement))
    .filter((statement) => statement.length > 0);
}

export async function runMigrations(input: {
  client: MigrationClient;
  dirs: readonly string[];
  log?: (line: string) => void;
}): Promise<MigrationRunResult> {
  const log = input.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const files = listMigrationFiles(input.dirs);
  const result: MigrationRunResult = { succeeded: 0, failed: 0, skipped: 0, files };

  await input.client.connect();
  try {
    await input.client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await input.client.query(
        `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER} (
          filename text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`,
      );
      const applied = new Map<string, string>();
      for (const row of ledgerRows(await input.client.query(
        `SELECT filename, checksum FROM ${MIGRATION_LEDGER}`,
      ))) {
        applied.set(row.filename, row.checksum);
      }

      const seen = new Set<string>();
      for (const file of files) {
        const filename = path.basename(file);
        if (seen.has(filename)) {
          throw new Error(`Migration filename appears twice: ${filename}`);
        }
        seen.add(filename);

        const sql = readFileSync(file, 'utf8').trim();
        if (sql.length === 0) {
          result.skipped += 1;
          continue;
        }
        const checksum = migrationChecksum(sql);
        const previous = applied.get(filename);
        if (previous === checksum) {
          result.skipped += 1;
          log(`skip ${file}`);
          continue;
        }
        if (previous) {
          throw new Error(
            `Migration ${filename} was already applied with a different checksum. Add a new file instead of editing it.`,
          );
        }
        const started = Date.now();
        try {
          const record = `INSERT INTO ${MIGRATION_LEDGER} (filename, checksum) VALUES ($1, $2)`;
          if (isConcurrentScript(sql)) {
            // CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
            const statements = splitConcurrentStatements(sql);
            if (statements.length === 0) {
              result.skipped += 1;
              continue;
            }
            for (const statement of statements) {
              await input.client.query(statement);
            }
            await input.client.query(record, [filename, checksum]);
          } else if (hasOwnTransaction(sql)) {
            await input.client.query(sql);
            await input.client.query(record, [filename, checksum]);
          } else {
            await input.client.query('BEGIN');
            await input.client.query(sql);
            await input.client.query(record, [filename, checksum]);
            await input.client.query('COMMIT');
          }
          result.succeeded += 1;
          log(`ok ${file} (${Date.now() - started} ms)`);
        } catch (error) {
          try {
            await input.client.query('ROLLBACK');
          } catch {
            // The failed statement may already have ended the transaction.
          }
          result.failed += 1;
          log(`failed ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      await input.client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    await input.client.end();
  }
  return result;
}
