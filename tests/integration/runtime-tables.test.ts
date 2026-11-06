/**
 * Applies the real migration directory when TEST_DATABASE_URL is set.
 * 002 and 003 must create the tables that startup and first use no longer create.
 * An event trigger on ddl_command_start counts every DDL command a store sends
 * after migrate. It fires before PostgreSQL checks IF NOT EXISTS, so a skipped
 * CREATE still counts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';
import { PostgresAdapter } from '../../src/infrastructure/database/PostgresAdapter';
import { PostgresSkillRelationGraphAdapter } from '../../src/infrastructure/agents/PostgresSkillRelationGraphAdapter';
import { PostgresFeatureFlagsStore } from '../../src/infrastructure/feature-flags/PostgresFeatureFlagsStore';
import { PostgresSpendStateStore } from '../../src/infrastructure/finops/PostgresSpendStateStore';
import { MasReadModelsRepository } from '../../src/infrastructure/mas/MasEventsRedisStreamsProjector';
import { PostgresMasExecutionStore } from '../../src/infrastructure/mas/PostgresMasExecutionStore';
import { PostgresTipStore } from '../../src/infrastructure/memory/stores/PostgresTipStore';
import { PostgresTrajectoryStore } from '../../src/infrastructure/memory/stores/PostgresTrajectoryStore';
import { PostgresSuccessLedgerStore } from '../../src/infrastructure/memory/stores/PostgresSuccessLedgerStore';
import { PostgresLessonStore } from '../../src/infrastructure/memory/stores/PostgresLessonStore';
import { PgErrorGraphRepository } from '../../src/infrastructure/debugging/PgErrorGraphRepository';
import { createPostgreSQLEventStore } from '../../src/infrastructure/events/postgres-event-store';
import { PostgreSQLOutbox } from '../../src/infrastructure/events/postgres-outbox';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_runtime_${process.pid}_${Date.now()}`;
let url = '';

const tables = [
  'public.learning_structured_tips',
  'public.learning_tip_feedback',
  'public.learning_extracted_lessons',
  'public.learning_consolidated_principles',
  'public.learning_success_ledger_entries',
  'public.learning_trajectory_intelligence',
  'public.learning_contrastive_trajectories',
  'public.error_graph_errors',
  'public.error_graph_patterns',
  'public.error_graph_fixes',
  'public.skill_relations',
  'public.skill_taxonomy',
  'public.skill_divisions',
  'public.skill_division_members',
  'public.app_feature_flags',
  'finops.agent_spend_state',
  'mas_runtime.mas_session_read_model',
  'mas_runtime.mas_task_stats_read_model',
];

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function onTestDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
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

test('migrate creates the tables that stores used to create on first use', { skip: !baseUrl }, async () => {
  await onTestDb(async (client) => {
    const found = await client.query<{ name: string }>(
      `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
        WHERE table_schema || '.' || table_name = ANY($1::text[])`,
      [tables],
    );
    assert.deepEqual(found.rows.map((row) => row.name).sort(), [...tables].sort());
    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname = ANY($1::text[])`,
      [[
        'idx_error_graph_embedding_hnsw',
        'idx_skill_relations_source',
        'idx_skill_relations_target',
        'idx_skill_relations_confidence',
      ]],
    );
    assert.equal(indexes.rowCount, 4);
  });
});

test('after migrate the first use of every kernel store sends no DDL', { skip: !baseUrl }, async () => {
  assert.notEqual(process.env.DB_RUNTIME_DDL, 'true');
  await onTestDb(async (client) => {
    await client.query(`CREATE TABLE public.ddl_probe_log (tag text NOT NULL, query text)`);
    await client.query(`
      CREATE FUNCTION public.ddl_probe_record() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.ddl_probe_log (tag, query) VALUES (tg_tag, left(current_query(), 160));
      END $$`);
    await client.query(`CREATE EVENT TRIGGER ddl_probe ON ddl_command_start EXECUTE FUNCTION public.ddl_probe_record()`);
  });

  const db = new PostgresAdapter({ connectionString: url, max: 2 });
  const eventStore = createPostgreSQLEventStore({ connection: { connectionString: url } }) as unknown as {
    initialize(): Promise<void>;
    close(): Promise<void>;
  };
  const outbox = new PostgreSQLOutbox({ connection: { connectionString: url } } as never, undefined, undefined as never);
  const masStore = new PostgresMasExecutionStore({ connection: { connectionString: url } });
  try {
    await new PostgresSkillRelationGraphAdapter(db).getRelations({ skillId: 'probe' });
    await new PostgresFeatureFlagsStore(db).loadFlags();
    await new PostgresSpendStateStore(db).listScopeIds();
    await new MasReadModelsRepository(db).initialize();
    await new PostgresTipStore(db).listTipFeedback();
    await new PostgresTrajectoryStore(db).listIntelligence();
    await new PostgresSuccessLedgerStore(db).listEntries();
    await new PostgresLessonStore(db).listLessons();
    const errorGraph = new PgErrorGraphRepository(db);
    await errorGraph.ensureHnswIndex();
    await errorGraph.getStats();
    await eventStore.initialize();
    await outbox.initialize();
    await masStore.initialize();
  } finally {
    await Promise.allSettled([db.close(), eventStore.close(), outbox.close(), masStore.close()]);
  }

  const logged = await onTestDb(async (client) => {
    const rows = await client.query<{ tag: string; query: string }>(`SELECT tag, query FROM public.ddl_probe_log`);
    await client.query(`DROP EVENT TRIGGER ddl_probe`);
    return rows.rows;
  });
  assert.deepEqual(logged, []);
});
