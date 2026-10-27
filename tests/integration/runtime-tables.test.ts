/**
 * Applies the real migration directory when TEST_DATABASE_URL is set.
 * 002 must create the tables that startup no longer creates.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_runtime_${process.pid}_${Date.now()}`;
let url = '';

const tables = [
  'learning_structured_tips',
  'learning_tip_feedback',
  'learning_extracted_lessons',
  'learning_consolidated_principles',
  'learning_success_ledger_entries',
  'learning_trajectory_intelligence',
  'learning_contrastive_trajectories',
  'error_graph_errors',
  'error_graph_patterns',
  'error_graph_fixes',
];

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

before(async () => {
  if (!baseUrl) return;
  await admin(`CREATE DATABASE ${dbName}`);
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  url = parsed.toString();
  const result = await runMigrations({
    client: new Client({ connectionString: url }),
    dirs: [CORE_MIGRATIONS_DIR],
    log: () => undefined,
  });
  assert.equal(result.failed, 0);
  assert.ok(result.succeeded >= 2);
});

after(async () => {
  if (!baseUrl) return;
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('migrate creates the learning and error-graph tables', { skip: !baseUrl }, async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const found = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables],
    );
    assert.deepEqual(found.rows.map((row) => row.table_name).sort(), [...tables].sort());
    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_error_graph_embedding_hnsw'`,
    );
    assert.equal(indexes.rowCount, 1);
  } finally {
    await client.end();
  }
});
