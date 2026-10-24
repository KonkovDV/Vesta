/**
 * MP-K23: a gsn reader skips an event whose transaction drew a lower gsn and
 * committed later. The commit-order reader must deliver it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createPostgreSQLEventStore, type CommitCursor } from '../../src/infrastructure/events/postgres-event-store';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';

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
