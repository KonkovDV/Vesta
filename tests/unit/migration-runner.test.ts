import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, type MigrationClient } from '../../src/infrastructure/database/migration-runner';
import { parseMigrationArgs } from '../../src/infrastructure/database/migrate-cli';

function fakeClient(failOn: string) {
  const executed: string[] = [];
  const client: MigrationClient = {
    async connect() {},
    async end() {},
    async query(sql: string) {
      executed.push(sql);
      if (sql.includes(failOn)) throw new Error('boom');
      return { rows: [] };
    },
  };
  return { client, executed };
}

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

test('a failed file stops the files after it unless continueOnError is set', async () => {
  const dir = await dirWith({ '001_a.sql': 'SELECT 1;', '002_b.sql': 'SELECT broken;', '003_c.sql': 'CREATE TABLE c ();' });
  const stopped = fakeClient('broken');
  const result = await runMigrations({ client: stopped.client, dirs: [dir], log: () => undefined });
  assert.deepEqual({ succeeded: result.succeeded, failed: result.failed, notRun: result.notRun }, { succeeded: 1, failed: 1, notRun: 1 });
  assert.equal(stopped.executed.some((sql) => sql.includes('CREATE TABLE c')), false);

  const continued = fakeClient('broken');
  const all = await runMigrations({ client: continued.client, dirs: [dir], log: () => undefined, continueOnError: true });
  assert.equal(all.succeeded, 2);
  assert.equal(continued.executed.some((sql) => sql.includes('CREATE TABLE c')), true);
});

test('each run sets a lock timeout before applying files', async () => {
  const dir = await dirWith({ '001_a.sql': 'SELECT 1;' });
  const { client, executed } = fakeClient('never');
  await runMigrations({ client, dirs: [dir], log: () => undefined });
  assert.ok(executed.some((sql) => /SET lock_timeout/.test(sql)));
});

test('the CLI accepts --continue-on-error next to --dir', () => {
  assert.deepEqual(parseMigrationArgs(['--dir', 'a', '--continue-on-error', '--dir=b']), { dirs: ['a', 'b'], continueOnError: true });
  assert.throws(() => parseMigrationArgs(['--unknown']), /Unknown argument/);
});
