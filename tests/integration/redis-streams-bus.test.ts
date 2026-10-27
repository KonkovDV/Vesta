/**
 * Redis Streams bus. Skips without TEST_REDIS_URL.
 * The idempotency case also needs TEST_DATABASE_URL (its own database).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { EventFactory } from '../../src/domain/events/event-store.interface';
import { RedisStreamsEventBus } from '../../src/infrastructure/events/redis-streams-event-bus';
import { createPostgresProcessedEventClaim } from '../../src/infrastructure/events/processed-event-claim';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';

const redisUrl = process.env.TEST_REDIS_URL;
const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_streams_${process.pid}_${Date.now()}`;
let databaseUrl = '';

function redisConnection(): { host: string; port: number } {
  const parsed = new URL(redisUrl ?? 'redis://127.0.0.1:6379');
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

function bus(prefix: string, overrides: Record<string, unknown> = {}): RedisStreamsEventBus {
  return new RedisStreamsEventBus({
    connection: redisConnection(),
    keyPrefix: prefix,
    groupName: 'readers',
    pollMs: 20,
    minIdleMs: 0,
    ...overrides,
  });
}

async function waitFor(ready: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 4000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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
  databaseUrl = parsed.toString();
  const result = await runMigrations({
    client: new Client({ connectionString: databaseUrl }),
    dirs: [CORE_MIGRATIONS_DIR],
    log: () => undefined,
  });
  assert.equal(result.failed, 0);
});

after(async () => {
  if (!baseUrl) return;
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('a subscriber that starts after the publish still receives the entry', { skip: !redisUrl }, async () => {
  const prefix = `backlog-${process.pid}-${Date.now()}:`;
  const publisher = bus(prefix);
  await publisher.initialize();
  const event = EventFactory.createBaseEvent('agg-backlog', 'StreamBacklog', { n: 1 }, 'corr_stream_backlog1');
  await publisher.publish(event);
  const seen: string[] = [];
  const reader = bus(prefix);
  await reader.initialize();
  await reader.subscribe('StreamBacklog', (delivered) => { seen.push(delivered.eventId); });
  try {
    await waitFor(() => seen.includes(event.eventId), 'backlog delivery');
  } finally {
    await reader.close();
    await publisher.close();
  }
});

test('a delivery that throws is claimed again by the next consumer', { skip: !redisUrl }, async () => {
  const prefix = `retry-${process.pid}-${Date.now()}:`;
  const event = EventFactory.createBaseEvent('agg-retry', 'StreamRetry', { n: 1 }, 'corr_stream_retry1');
  let deliveries = 0;
  const first = bus(prefix, { minIdleMs: 60_000 });
  await first.initialize();
  await first.publish(event);
  await first.subscribe('StreamRetry', async () => {
    deliveries += 1;
    throw new Error('consumer died');
  });
  try {
    await waitFor(() => deliveries === 1, 'first delivery');
  } finally {
    await first.close();
  }
  const second = bus(prefix, { minIdleMs: 0 });
  await second.initialize();
  await second.subscribe('StreamRetry', async () => { deliveries += 1; });
  try {
    await waitFor(() => deliveries === 2, 'redelivery');
  } finally {
    await second.close();
  }
});

test('a finished event id is not handled twice', { skip: !redisUrl || !baseUrl }, async () => {
  const prefix = `once-${process.pid}-${Date.now()}:`;
  const claim = createPostgresProcessedEventClaim(databaseUrl);
  const event = EventFactory.createBaseEvent('agg-once', 'StreamOnce', { n: 1 }, 'corr_stream_once1');
  let handled = 0;
  const reader = bus(prefix, { claim });
  await reader.initialize();
  await reader.subscribe('StreamOnce', async () => { handled += 1; });
  try {
    await reader.publish(event);
    await reader.publish(event);
    await waitFor(() => handled === 1, 'first handling');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(handled, 1);
  } finally {
    await reader.close();
  }
});
