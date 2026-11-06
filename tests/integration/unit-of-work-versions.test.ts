/**
 * MP-K40 (unit of work): an event that carries the version it was decided on
 * (aggregateVersion >= 1) must find the journal at that version minus one.
 * Several aggregates flushed by one unit of work commit together or not at all,
 * like a multi-stream append with an expected revision per stream.
 * aggregateVersion 0 means "the store numbers it" and still appends at the end.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';
import { PostgresAdapter } from '../../src/infrastructure/database/PostgresAdapter';
import { PostgresUnitOfWork } from '../../src/infrastructure/database/PostgresUnitOfWork';
import { PostgreSQLOutbox } from '../../src/infrastructure/events/postgres-outbox';
import type { DomainEvent } from '../../src/domain/events/event-store.interface';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_uow_${process.pid}_${Date.now()}`;
let url = '';
let seq = 0;

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function versions(aggregateId: string): Promise<number[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const rows = await client.query<{ v: number }>(
      'SELECT aggregate_version AS v FROM event_store.events WHERE aggregate_id = $1 ORDER BY aggregate_version',
      [aggregateId],
    );
    return rows.rows.map((row) => row.v);
  } finally {
    await client.end();
  }
}

function event(aggregateId: string, aggregateVersion: number): DomainEvent {
  seq += 1;
  return {
    eventId: `uow-${process.pid}-${seq}`,
    type: 'UowProbe',
    aggregateId,
    aggregateVersion,
    correlationId: `corr_uow_probe_${String(seq).padStart(4, '0')}`,
    timestamp: new Date(),
    payload: { seq },
  } as DomainEvent;
}

/** Runs work in its own async context, as two separate requests would. */
function isolated<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => setImmediate(() => { work().then(resolve, reject); }));
}

function owner(id: string) {
  return { id: { toString: () => id } };
}

function setup() {
  const db = new PostgresAdapter({ connectionString: url, max: 6 });
  const outbox = new PostgreSQLOutbox({ connection: { connectionString: url } } as never, undefined, undefined as never);
  const uow = () => new PostgresUnitOfWork(db, outbox);
  return { uow, close: () => Promise.allSettled([db.close(), outbox.close()]) };
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

after(async () => {
  if (!baseUrl) return;
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('two units of work decided on one version: one commits, the other conflicts', { skip: !baseUrl }, async () => {
  const { uow, close } = setup();
  try {
    const flush = (unit: PostgresUnitOfWork) => unit.executeInTransaction(async () => {
      unit.registerChanged(owner('uow-race'), [event('uow-race', 1)]);
    });
    const results = await Promise.allSettled([isolated(() => flush(uow())), isolated(() => flush(uow()))]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason?.message ?? rejected.reason), /version conflict/);
    assert.deepEqual(await versions('uow-race'), [1]);
  } finally {
    await close();
  }
});

test('a conflict on one aggregate rolls back every aggregate of that unit of work', { skip: !baseUrl }, async () => {
  const { uow, close } = setup();
  try {
    const first = uow();
    await first.executeInTransaction(async () => {
      first.registerChanged(owner('uow-taken'), [event('uow-taken', 1)]);
    });
    const second = uow();
    await assert.rejects(second.executeInTransaction(async () => {
      second.registerChanged(owner('uow-fresh'), [event('uow-fresh', 1), event('uow-fresh', 2)]);
      second.registerChanged(owner('uow-taken'), [event('uow-taken', 1)]);
    }), /version conflict/);
    assert.deepEqual(await versions('uow-fresh'), [], 'nothing of the failed unit of work is journaled');
    assert.deepEqual(await versions('uow-taken'), [1]);
  } finally {
    await close();
  }
});

test('an event without a decided version is appended after the head', { skip: !baseUrl }, async () => {
  const { uow, close } = setup();
  try {
    for (let round = 0; round < 2; round += 1) {
      const unit = uow();
      await unit.executeInTransaction(async () => {
        unit.registerChanged(owner('uow-any'), [event('uow-any', 0)]);
      });
    }
    assert.deepEqual(await versions('uow-any'), [1, 2]);
  } finally {
    await close();
  }
});
