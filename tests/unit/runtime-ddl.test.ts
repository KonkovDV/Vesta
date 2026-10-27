import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IDatabaseConnection } from '../../src/domain/persistence/IDatabaseConnection';
import { requirePublicTables, runtimeDdlEnabled } from '../../src/infrastructure/database/runtime-ddl';

test('runtime DDL stays off unless the flag is true', () => {
  const previous = process.env.DB_RUNTIME_DDL;
  delete process.env.DB_RUNTIME_DDL;
  assert.equal(runtimeDdlEnabled(), false);
  process.env.DB_RUNTIME_DDL = 'true';
  assert.equal(runtimeDdlEnabled(), true);
  if (previous === undefined) delete process.env.DB_RUNTIME_DDL;
  else process.env.DB_RUNTIME_DDL = previous;
});

test('a missing learning table tells the operator to apply migrations', async () => {
  const db = {
    async query() {
      return { rows: [{ table_name: 'learning_structured_tips' }], rowCount: 1 };
    },
  };
  await assert.rejects(
    () => requirePublicTables(db as unknown as IDatabaseConnection, [
      'learning_structured_tips',
      'learning_tip_feedback',
    ]),
    /learning_tip_feedback[\s\S]*Apply migrations/,
  );
});

test('the runtime migration names the learning and error-graph tables', () => {
  const sql = readFileSync(
    path.join(__dirname, '../../src/infrastructure/database/migrations/002_runtime_tables.sql'),
    'utf8',
  );
  for (const name of [
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
    'idx_error_graph_embedding_hnsw',
  ]) {
    assert.match(sql, new RegExp(name));
  }
  assert.equal(sql.includes('CONCURRENTLY'), false);
});
