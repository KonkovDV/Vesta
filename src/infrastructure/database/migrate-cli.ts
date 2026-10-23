#!/usr/bin/env node
/**
 * Applies kernel migrations, then each `--dir` given by a project.
 *
 *   DATABASE_URL=postgresql://... microphoenix-migrate --dir ./migrations
 *
 * Exit code 1 when any file fails or the connection cannot be opened.
 *
 * @layer Infrastructure
 */
import { Client } from 'pg';

import { readStr } from '../../core/config/app-config';
import { CORE_MIGRATIONS_DIR, runMigrations } from './migration-runner';

export function parseMigrationDirs(argv: readonly string[]): string[] {
  const dirs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--dir needs a directory path');
      }
      dirs.push(value);
      index += 1;
    } else if (arg.startsWith('--dir=')) {
      dirs.push(arg.slice('--dir='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return dirs;
}

async function main(): Promise<void> {
  const databaseUrl = readStr('DATABASE_URL');
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }
  const dirs = [CORE_MIGRATIONS_DIR, ...parseMigrationDirs(process.argv.slice(2))];
  const result = await runMigrations({ client: new Client({ connectionString: databaseUrl }), dirs });
  process.stdout.write(
    `migrations: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} empty, ${result.files.length} files\n`,
  );
  process.exit(result.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`migration runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
