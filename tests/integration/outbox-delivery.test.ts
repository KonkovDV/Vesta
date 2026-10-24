/**
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm run test:integration
 * Each run creates and drops its own database.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { PostgreSQLOutbox } from '../../src/infrastructure/events/postgres-outbox';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_outbox_${process.pid}_${Date.now()}`;
let url = '';

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return (await client.query(sql, params)).rows as T[]; } finally { await client.end(); }
}

async function insertMessage(id: string, aggregateId: string, version: number): Promise<void> {
  await query(
    `INSERT INTO outbox.messages (message_id, event_id, event_type, aggregate_id, aggregate_version, correlation_id, event_timestamp, event_payload)
     VALUES ($1, $1, 'Probe', $2, $3, 'corr_outbox_0001', now(), '{}')`,
    [id, aggregateId, version],
  );
}

function outbox(bus: { publish(event: { eventId: string }): Promise<void> }, overrides: Record<string, unknown> = {}) {
  return new PostgreSQLOutbox({
    connection: { connectionString: url },
    maxRetries: 3,
    retryDelayMs: 60_000,
    batchSize: 10,
    processingLeaseSeconds: 1,
    ...overrides,
  } as never, undefined, bus as never);
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

test('a failed publish waits for its backoff before the next claim', { skip: !baseUrl }, async () => {
  await insertMessage('m-fail', 'agg-fail', 1);
  let attempts = 0;
  const box = outbox({ async publish() { attempts += 1; throw new Error('bus down'); } });
  await box.processPendingMessages();
  await box.processPendingMessages();
  await box.close();
  assert.equal(attempts, 1, 'the second poll must not retry immediately');
  const [row] = await query<{ status: string; due_later: boolean }>(
    `SELECT status, next_attempt_at > now() + interval '20 seconds' AS due_later FROM outbox.messages WHERE message_id = 'm-fail'`,
  );
  assert.deepEqual(row, { status: 'FAILED', due_later: true });
});

test('versions of one aggregate are published in order', { skip: !baseUrl }, async () => {
  await insertMessage('m-v2', 'agg-order', 2);
  await insertMessage('m-v1', 'agg-order', 1);
  const published: string[] = [];
  const box = outbox({ async publish(event) { published.push(event.eventId); } });
  await box.processPendingMessages();
  assert.deepEqual(published, ['m-v1'], 'v2 waits while v1 is open');
  await box.processPendingMessages();
  await box.close();
  assert.deepEqual(published, ['m-v1', 'm-v2']);
});

test('an expired lease counts as an attempt and a poisoned row reaches the DLQ', { skip: !baseUrl }, async () => {
  await insertMessage('m-poison', 'agg-poison', 1);
  await query(`UPDATE outbox.messages SET status = 'PROCESSING', retry_count = 2, last_retry_at = now() - interval '1 hour' WHERE message_id = 'm-poison'`);
  let published = 0;
  const box = outbox({ async publish() { published += 1; } });
  await box.processPendingMessages();
  await box.close();
  assert.equal(published, 0);
  assert.equal((await query(`SELECT 1 FROM outbox.messages WHERE message_id = 'm-poison'`)).length, 0);
  assert.equal((await query(`SELECT 1 FROM outbox.dead_letter_queue WHERE original_message_id = 'm-poison'`)).length, 1);
});

test('a worker whose lease was taken over cannot mark the row', { skip: !baseUrl }, async () => {
  await insertMessage('m-lease', 'agg-lease', 1);
  let release!: () => void;
  const slowBus = { publish: () => new Promise<void>((resolve) => { release = resolve; }) };
  const slow = outbox(slowBus);
  const firstPoll = slow.processPendingMessages();
  await new Promise((resolve) => setTimeout(resolve, 1500)); // lease (1 s) expires
  const fast = outbox({ async publish() { /* delivered again: at-least-once */ } });
  await fast.processPendingMessages();
  const [taken] = await query<{ status: string; lease_token: string | null }>(`SELECT status, lease_token FROM outbox.messages WHERE message_id = 'm-lease'`);
  assert.equal(taken.status, 'PUBLISHED');
  // Re-open the row as if a third worker had claimed it, then let the slow worker finish.
  await query(`UPDATE outbox.messages SET status = 'PROCESSING', lease_token = 'someone-else' WHERE message_id = 'm-lease'`);
  release();
  await firstPoll;
  await slow.close();
  await fast.close();
  const [row] = await query<{ status: string; lease_token: string }>(`SELECT status, lease_token FROM outbox.messages WHERE message_id = 'm-lease'`);
  assert.deepEqual(row, { status: 'PROCESSING', lease_token: 'someone-else' });
});

test('with the DLQ disabled an exhausted v1 does not block v2 forever', { skip: !baseUrl }, async () => {
  await insertMessage('m-x1', 'agg-exhausted', 1);
  await insertMessage('m-x2', 'agg-exhausted', 2);
  await query(`UPDATE outbox.messages SET status = 'FAILED', retry_count = 3 WHERE message_id = 'm-x1'`);
  const published: string[] = [];
  const box = outbox({ async publish(event) { published.push(event.eventId); } }, { enableDeadLetterQueue: false });
  await box.processPendingMessages();
  await box.close();
  assert.deepEqual(published, ['m-x2']);
});

test('with the DLQ disabled a poisoned lease ends FAILED and is not claimed again', { skip: !baseUrl }, async () => {
  await insertMessage('m-p1', 'agg-poison-nodlq', 1);
  await query(`UPDATE outbox.messages SET status = 'PROCESSING', retry_count = 2, last_retry_at = now() - interval '1 hour' WHERE message_id = 'm-p1'`);
  let published = 0;
  const box = outbox({ async publish() { published += 1; } }, { enableDeadLetterQueue: false });
  await box.processPendingMessages();
  await box.processPendingMessages();
  await box.close();
  assert.equal(published, 0);
  const [row] = await query<{ status: string; retry_count: number }>(`SELECT status, retry_count FROM outbox.messages WHERE message_id = 'm-p1'`);
  assert.equal(row.status, 'FAILED');
  assert.ok(row.retry_count >= 3, 'retries are used up, so no claim selects it');
});

test('a write that names its expected version fails instead of re-numbering after a concurrent write', { skip: !baseUrl }, async () => {
  const { EventFactory } = await import('../../src/domain/events/event-store.interface');
  const { ConcurrencyError } = await import('../../src/domain/errors/DomainError');
  const box = outbox({ async publish() {} });
  const event = (n: number) => EventFactory.createBaseEvent('agg-occ', 'Probe', { n }, 'corr_outbox_occ_1');
  await box.saveEventsWithOutbox([event(1)], undefined, { expectedAggregateVersion: 0 });
  // Two writers both decided on version 1.
  const results = await Promise.allSettled([
    box.saveEventsWithOutbox([event(2)], undefined, { expectedAggregateVersion: 1 }),
    box.saveEventsWithOutbox([event(3)], undefined, { expectedAggregateVersion: 1 }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof ConcurrencyError, String(rejected.reason));
  await assert.rejects(box.saveEventsWithOutbox([event(4)], undefined, { expectedAggregateVersion: 5 }), ConcurrencyError);
  // Without a version the old behaviour stays: append after whatever is stored.
  await box.saveEventsWithOutbox([event(5)]);
  await box.close();
  const rows = await query<{ v: number }>(`SELECT aggregate_version AS v FROM event_store.events WHERE aggregate_id = 'agg-occ' ORDER BY 1`);
  assert.deepEqual(rows.map((row) => Number(row.v)), [1, 2, 3]);
});
