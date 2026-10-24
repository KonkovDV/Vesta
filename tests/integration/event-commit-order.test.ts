/**
 * MP-K23: a gsn reader skips an event whose transaction drew a lower gsn and
 * committed later. The commit-order reader must deliver it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createPostgreSQLEventStore, type CommitCursor } from '../../src/infrastructure/events/postgres-event-store';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';
import { SemanticEmbeddingWorker } from '../../src/application/workers/SemanticEmbeddingWorker';
import type { IEventVectorizer } from '../../src/domain/memory/IEventVectorizer';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_commit_${process.pid}_${Date.now()}`;
let url = '';

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
  const result = await runMigrations({ client: new Client({ connectionString: url }), dirs: [CORE_MIGRATIONS_DIR], log: () => undefined });
  assert.equal(result.failed, 0);
});
after(async () => { if (baseUrl) await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); });

const insert = (client: Client, id: string) => client.query(
  `INSERT INTO event_store.events (event_id, event_type, aggregate_id, aggregate_version, correlation_id, timestamp, payload)
   VALUES ($1, 'Probe', $1, 1, 'corr_commit_0001', now(), '{}') RETURNING gsn`, [id]);

test('an event committed after a later gsn is still delivered in commit order', { skip: !baseUrl }, async () => {
  const store = createPostgreSQLEventStore({ connection: { connectionString: url } }) as unknown as {
    getCommittedEventsAfter(cursor: CommitCursor | null): Promise<{ events: Array<{ eventId: string }>; cursor: CommitCursor | null }>;
    close(): Promise<void>;
  };
  const early = new Client({ connectionString: url });
  const late = new Client({ connectionString: url });
  await Promise.all([early.connect(), late.connect()]);
  try {
    await early.query('BEGIN');
    await insert(early, 'slow-writer');            // lower gsn, still open
    await late.query('BEGIN');
    await insert(late, 'fast-writer');             // higher gsn
    await late.query('COMMIT');

    const first = await store.getCommittedEventsAfter(null);
    assert.deepEqual(first.events.map((event) => event.eventId), [], 'nothing past the open transaction');

    await early.query('COMMIT');
    const delivered: string[] = [];
    let cursor = first.cursor;
    for (let poll = 0; poll < 3; poll += 1) {
      const page = await store.getCommittedEventsAfter(cursor);
      delivered.push(...page.events.map((event) => event.eventId));
      cursor = page.cursor;
    }
    assert.deepEqual(delivered.sort(), ['fast-writer', 'slow-writer']);
  } finally {
    await Promise.all([early.end(), late.end()]);
    await store.close();
  }
});

test('the embedding worker vectorizes a late commit and resumes from its stored cursor', { skip: !baseUrl }, async () => {
  const store = createPostgreSQLEventStore({ connection: { connectionString: url } });
  const seen: string[] = [];
  const vectorizer = {
    isReady: true,
    dimensions: 384,
    initialize: async () => undefined,
    vectorizeBatch: async (texts: string[]) => {
      seen.push(...texts);
      return texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));
    },
  } as unknown as IEventVectorizer;
  const options = { batchSize: 50, pollIntervalMs: 60_000, enabled: true, consumerName: 'embedding-probe' };
  const quiet = { info: () => undefined, error: () => undefined };
  const early = new Client({ connectionString: url });
  const late = new Client({ connectionString: url });
  const check = new Client({ connectionString: url });
  await Promise.all([early.connect(), late.connect(), check.connect()]);
  try {
    await check.query('UPDATE event_store.events SET semantic_embedding = NULL');
    const before = Number((await check.query('SELECT count(*) AS n FROM event_store.events')).rows[0].n);

    await early.query('BEGIN');
    await insert(early, 'embed-slow');
    await late.query('BEGIN');
    await insert(late, 'embed-fast');
    await late.query('COMMIT');

    const worker = new SemanticEmbeddingWorker(store, vectorizer, options, quiet, store);
    await worker.tick();
    await early.query('COMMIT');
    await worker.tick();

    const missing = await check.query(
      `SELECT event_id FROM event_store.events WHERE semantic_embedding IS NULL ORDER BY event_id`,
    );
    assert.deepEqual(missing.rows, [], 'every committed event has an embedding');
    assert.equal(seen.length, before + 2);

    const restarted = new SemanticEmbeddingWorker(store, vectorizer, options, quiet, store);
    assert.equal(await restarted.tick(), 0, 'a restart does not read the journal again');

    const stored = await store.loadConsumerCursor('embedding-probe');
    assert.ok(stored);
    await store.saveConsumerCursor('embedding-probe', { txId: '1', gsn: 1 });
    assert.deepEqual(await store.loadConsumerCursor('embedding-probe'), stored, 'an older cursor is ignored');
  } finally {
    await Promise.all([early.end(), late.end(), check.end()]);
    await store.close();
  }
});
