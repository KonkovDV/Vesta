import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IDatabaseConnection } from '../../src/domain/persistence/IDatabaseConnection';
import { requirePublicTables, runtimeDdlEnabled } from '../../src/infrastructure/database/runtime-ddl';
import { PostgresSkillRelationGraphAdapter } from '../../src/infrastructure/agents/PostgresSkillRelationGraphAdapter';
import { PostgresFeatureFlagsStore } from '../../src/infrastructure/feature-flags/PostgresFeatureFlagsStore';
import { PostgresSpendStateStore } from '../../src/infrastructure/finops/PostgresSpendStateStore';
import { MasReadModelsRepository } from '../../src/infrastructure/mas/MasEventsRedisStreamsProjector';

/** A database without any table. Every statement is recorded and answers no rows. */
function emptyDatabase(): { db: IDatabaseConnection; sent: string[] } {
  const sent: string[] = [];
  const db = {
    async query(sql: string) { sent.push(sql); return { rows: [], rowCount: 0 }; },
    async queryOne(sql: string) { sent.push(sql); return null; },
    async execute(sql: string) { sent.push(sql); return 0; },
    async transaction<T>(work: () => Promise<T>) { return work(); },
  };
  return { db: db as unknown as IDatabaseConnection, sent };
}

async function withRuntimeDdl<T>(value: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env.DB_RUNTIME_DDL;
  if (value === undefined) delete process.env.DB_RUNTIME_DDL;
  else process.env.DB_RUNTIME_DDL = value;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.DB_RUNTIME_DDL;
    else process.env.DB_RUNTIME_DDL = previous;
  }
}

const firstUse: Array<[string, (db: IDatabaseConnection) => Promise<unknown>]> = [
  ['skill relations', (db) => new PostgresSkillRelationGraphAdapter(db).getRelations({ skillId: 'probe' })],
  ['feature flags', (db) => new PostgresFeatureFlagsStore(db).loadFlags()],
  ['finops spend state', (db) => new PostgresSpendStateStore(db).listScopeIds()],
  ['MAS read models', (db) => new MasReadModelsRepository(db).initialize()],
];

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

test('a store that created its tables on first use asks for migrations instead', async () => {
  await withRuntimeDdl(undefined, async () => {
    for (const [name, use] of firstUse) {
      const { db, sent } = emptyDatabase();
      await assert.rejects(use(db), /Apply migrations/, name);
      assert.deepEqual(sent.filter((sql) => /\b(CREATE|ALTER)\b/i.test(sql)), [], name);
    }
  });
});

test('the first-use migration names the skill-graph and finops tables', () => {
  const sql = readFileSync(
    path.join(__dirname, '../../src/infrastructure/database/migrations/003_skill_graph_finops.sql'),
    'utf8',
  );
  for (const name of [
    'skill_relations',
    'skill_taxonomy',
    'skill_divisions',
    'skill_division_members',
    'idx_skill_relations_source',
    'idx_skill_relations_target',
    'idx_skill_relations_confidence',
    'finops.agent_spend_state',
  ]) {
    assert.match(sql, new RegExp(name));
  }
  assert.equal(sql.includes('CONCURRENTLY'), false);
});

test('with DB_RUNTIME_DDL=true the MAS read models use the baseline text ids', async () => {
  await withRuntimeDdl('true', async () => {
    const { db, sent } = emptyDatabase();
    await new MasReadModelsRepository(db).initialize();
    const creates = sent.filter((sql) => /CREATE TABLE/i.test(sql));
    assert.equal(creates.length, 2);
    for (const sql of creates) assert.doesNotMatch(sql, /\bUUID\b/i);
  });
});
