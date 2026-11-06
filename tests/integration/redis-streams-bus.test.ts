/**
 * Redis Streams bus. Skips without TEST_REDIS_URL.
 * The idempotency case also needs TEST_DATABASE_URL (its own database).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { EventFactory } from '../../src/domain/events/event-store.interface';
import Redis from 'ioredis';
import { RedisStreamsEventBus, streamFeaturesFor } from '../../src/infrastructure/events/redis-streams-event-bus';
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

/** A raw client for checks the bus does not expose. */
async function withRaw<T>(work: (raw: Redis) => Promise<T>): Promise<T> {
  const raw = new Redis({ ...redisConnection(), lazyConnect: true, maxRetriesPerRequest: 1 });
  await raw.connect();
  try { return await work(raw); } finally { await raw.quit(); }
}

async function serverFeatures(): Promise<{ ackedTrim: boolean; idempotentAdd: boolean }> {
  const info = await withRaw((raw) => raw.info('server'));
  return streamFeaturesFor(/redis_version:([^\r\n]+)/.exec(info)?.[1]);
}

test('the bus picks its XADD options from the server version', { skip: !redisUrl }, async () => {
  const reader = bus(`features-${process.pid}-${Date.now()}:`);
  await reader.initialize();
  try {
    assert.deepEqual(reader.getStreamFeatures(), await serverFeatures());
  } finally {
    await reader.close();
  }
});

test('trimming keeps entries a consumer group has not acknowledged (Redis 8.2+)', { skip: !redisUrl }, async (t) => {
  if (!(await serverFeatures()).ackedTrim) {
    t.skip('server older than Redis 8.2: MAXLEN still trims unacknowledged entries');
    return;
  }
  const prefix = `acked-${process.pid}-${Date.now()}:`;
  const stream = `${prefix}stream:StreamBacklog`;
  // A group that exists and reads nothing: a consumer that is down.
  await withRaw((raw) => raw.xgroup('CREATE', stream, 'slow-readers', '0', 'MKSTREAM'));
  // The hard cap is out of reach here; the next test covers it.
  const writer = bus(prefix, { maxLen: 10, hardMaxLen: 10_000 });
  await writer.initialize();
  try {
    for (let i = 0; i < 400; i += 1) {
      await writer.publish(EventFactory.createBaseEvent(`agg-${i}`, 'StreamBacklog', { i }, 'corr_stream_backlog'));
    }
    assert.equal(await withRaw((raw) => raw.xlen(stream)), 400, 'no unacknowledged entry was trimmed');
  } finally {
    await writer.close();
    await withRaw((raw) => raw.del(stream));
  }
});

test('a repeated publish of one event adds one entry; a dead-letter replay adds another (Redis 8.6+)', { skip: !redisUrl }, async (t) => {
  if (!(await serverFeatures()).idempotentAdd) {
    t.skip('server older than Redis 8.6: no IDMP, processed_events skips the repeat');
    return;
  }
  const prefix = `idmp-${process.pid}-${Date.now()}:`;
  const stream = `${prefix}stream:StreamTwice`;
  const event = EventFactory.createBaseEvent('agg-twice', 'StreamTwice', { n: 1 }, 'corr_stream_twice1');
  const writer = bus(prefix);
  await writer.initialize();
  try {
    await writer.publish(event);
    await writer.publish(event);
    assert.equal(await withRaw((raw) => raw.xlen(stream)), 1, 'the outbox retry of one row is one entry');
    await writer.replayDeadLetterEvent({ originalEvent: event, error: { message: 'probe' }, deadLetterAt: new Date(), retryCount: 5 });
    assert.equal(await withRaw((raw) => raw.xlen(stream)), 2, 'a replay is a new delivery');
  } finally {
    await writer.close();
    await withRaw((raw) => raw.del(stream));
  }
});

test('a server that denies INFO still gets a working bus, with the pre-8.2 XADD', { skip: !redisUrl }, async () => {
  await withRaw((raw) => raw.call('ACL', 'SETUSER', 'default', '-info'));
  const prefix = `noinfo-${process.pid}-${Date.now()}:`;
  const writer = bus(prefix);
  try {
    await writer.initialize();
    assert.deepEqual(writer.getStreamFeatures(), { ackedTrim: false, idempotentAdd: false });
    await writer.publish(EventFactory.createBaseEvent('agg-noinfo', 'StreamNoInfo', { n: 1 }, 'corr_stream_noinfo'));
    assert.equal(await withRaw((raw) => raw.xlen(`${prefix}stream:StreamNoInfo`)), 1);
  } finally {
    await withRaw((raw) => raw.call('ACL', 'SETUSER', 'default', '+@all'));
    await writer.close();
    await withRaw((raw) => raw.del(`${prefix}stream:StreamNoInfo`));
  }
});

test('an entry the bus cannot read goes to the dead-letter stream and does not stop the entries behind it', { skip: !redisUrl }, async () => {
  const prefix = `poison-${process.pid}-${Date.now()}:`;
  const stream = `${prefix}stream:StreamPoison`;
  await withRaw(async (raw) => {
    await raw.xadd(stream, '*', 'body', 'not json');
    await raw.xadd(stream, '*', 'other', 'field');
  });
  const writer = bus(prefix);
  await writer.initialize();
  const event = EventFactory.createBaseEvent('agg-poison', 'StreamPoison', { n: 1 }, 'corr_stream_poison1');
  await writer.publish(event);
  const seen: string[] = [];
  const reader = bus(prefix);
  await reader.initialize();
  await reader.subscribe('StreamPoison', (delivered) => { seen.push(delivered.eventId); });
  try {
    await waitFor(() => seen.includes(event.eventId), 'the entry behind two unreadable ones');
    const dead = await reader.getDeadLetterQueue('StreamPoison');
    assert.equal(dead.length, 2);
    assert.ok(dead.every((row) => row.error.message === 'unreadable stream entry'));
    const pending = await withRaw((raw) => raw.xpending(stream, 'readers')) as unknown[];
    assert.equal(pending[0], 0, 'nothing is left pending');
  } finally {
    await reader.close();
    await writer.close();
    await withRaw((raw) => raw.del(stream, `${prefix}dlq:StreamPoison`));
  }
});

test('an entry whose consumers died maxDeliveries times goes to the dead-letter stream without running again', { skip: !redisUrl }, async () => {
  const prefix = `crash-${process.pid}-${Date.now()}:`;
  const stream = `${prefix}stream:StreamCrash`;
  const writer = bus(prefix);
  await writer.initialize();
  const event = EventFactory.createBaseEvent('agg-crash', 'StreamCrash', { n: 1 }, 'corr_stream_crash1');
  await writer.publish(event);
  await withRaw(async (raw) => {
    // Two processes read the entry and stopped before acknowledging it.
    await raw.xgroup('CREATE', stream, 'readers', '0');
    await raw.xreadgroup('GROUP', 'readers', 'dead-1', 'COUNT', 1, 'STREAMS', stream, '>');
    await raw.xautoclaim(stream, 'readers', 'dead-2', 0, '0-0', 'COUNT', 1);
  });
  let handled = 0;
  const reader = bus(prefix, { maxDeliveries: 2 });
  await reader.initialize();
  await reader.subscribe('StreamCrash', async () => { handled += 1; });
  try {
    let dead: Awaited<ReturnType<typeof reader.getDeadLetterQueue>> = [];
    const start = Date.now();
    while (dead.length === 0 && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      dead = await reader.getDeadLetterQueue('StreamCrash');
    }
    assert.equal(dead.length, 1);
    assert.equal(dead[0].originalEvent.eventId, event.eventId);
    assert.equal(dead[0].error.message, 'delivered 3 times without an acknowledgement');
    assert.equal(handled, 0, 'the handler did not run a third time');
  } finally {
    await reader.close();
    await writer.close();
    await withRaw((raw) => raw.del(stream, `${prefix}dlq:StreamCrash`));
  }
});

test('a bus that stops with nothing pending leaves no consumer in the group', { skip: !redisUrl }, async () => {
  const prefix = `release-${process.pid}-${Date.now()}:`;
  const stream = `${prefix}stream:StreamRelease`;
  const event = EventFactory.createBaseEvent('agg-release', 'StreamRelease', { n: 1 }, 'corr_stream_release1');
  const reader = bus(prefix);
  await reader.initialize();
  let handled = 0;
  await reader.subscribe('StreamRelease', async () => { handled += 1; });
  await reader.publish(event);
  await waitFor(() => handled === 1, 'delivery');
  await reader.close();
  try {
    const consumers = await withRaw((raw) => raw.xinfo('CONSUMERS', stream, 'readers')) as unknown[];
    assert.equal(consumers.length, 0);
  } finally {
    await withRaw((raw) => raw.del(stream));
  }
});

test('an idle bus reads less often, and a publish from the same process is delivered at once', { skip: !redisUrl }, async () => {
  const prefix = `quiet-${process.pid}-${Date.now()}:`;
  const reader = bus(prefix, { pollMs: 20, maxPollMs: 2000 });
  await reader.initialize();
  const seen: number[] = [];
  await reader.subscribe('StreamQuiet', async () => { seen.push(Date.now()); });
  const processed = async () =>
    Number(/total_commands_processed:(\d+)/.exec(await withRaw((raw) => raw.info('stats')))?.[1]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const before = await processed();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const idle = (await processed()) - before;
    assert.ok(idle < 20, `${idle} commands in 2 s without entries; a fixed 20 ms poll sends about 200`);
    const sentAt = Date.now();
    await reader.publish(EventFactory.createBaseEvent('agg-quiet', 'StreamQuiet', { n: 1 }, 'corr_stream_quiet1'));
    await waitFor(() => seen.length === 1, 'delivery after a publish');
    assert.ok(seen[0] - sentAt < 500, `delivered ${seen[0] - sentAt} ms after the publish`);
  } finally {
    await reader.close();
    await withRaw((raw) => raw.del(`${prefix}stream:StreamQuiet`));
  }
});

test('a failed hard cap check does not fail the publish (Redis 8.2+)', { skip: !redisUrl }, async (t) => {
  if (!(await serverFeatures()).ackedTrim) {
    t.skip('server older than Redis 8.2: no hard cap check');
    return;
  }
  const prefix = `capfail-${process.pid}-${Date.now()}:`;
  const stream = `${prefix}stream:StreamCapFail`;
  // Neither MAXLEN nor the cap trims 12 entries; the checks after the 5th and 10th publish fail.
  const writer = bus(prefix, { maxLen: 100, hardMaxLen: 100, hardCapCheckEvery: 5 });
  await writer.initialize();
  await withRaw((raw) => raw.call('ACL', 'SETUSER', 'default', '-xlen'));
  try {
    for (let i = 0; i < 12; i += 1) {
      await writer.publish(EventFactory.createBaseEvent(`agg-${i}`, 'StreamCapFail', { i }, 'corr_stream_capfail'));
    }
  } finally {
    await withRaw((raw) => raw.call('ACL', 'SETUSER', 'default', '+@all'));
    await writer.close();
  }
  try {
    assert.equal(await withRaw((raw) => raw.xlen(stream)), 12, 'every publish added its entry');
  } finally {
    await withRaw((raw) => raw.del(stream));
  }
});

test('a group that stops reading cannot grow a stream past the hard cap (Redis 8.2+)', { skip: !redisUrl }, async (t) => {
  if (!(await serverFeatures()).ackedTrim) {
    t.skip('server older than Redis 8.2: MAXLEN already bounds the stream');
    return;
  }
  const prefix = `hardcap-${process.pid}-${Date.now()}:`;
  const stream = `${prefix}stream:StreamHardCap`;
  await withRaw((raw) => raw.xgroup('CREATE', stream, 'gone-service', '0', 'MKSTREAM'));
  const writer = bus(prefix, { maxLen: 10, hardMaxLen: 100, hardCapCheckEvery: 10 });
  await writer.initialize();
  try {
    for (let i = 0; i < 400; i += 1) {
      await writer.publish(EventFactory.createBaseEvent(`agg-${i}`, 'StreamHardCap', { i }, 'corr_stream_hardcap'));
    }
    const length = await withRaw((raw) => raw.xlen(stream));
    assert.ok(length <= 110, `stream holds ${length} entries`);
    assert.ok(length >= 100, 'the hard cap keeps the newest entries, not fewer');
    assert.ok(writer.getForcedTrimCount() > 0, 'a forced trim is counted');
  } finally {
    await writer.close();
    await withRaw((raw) => raw.del(stream));
  }
});
