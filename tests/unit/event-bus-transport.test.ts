import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEventBusTransport } from '../../src/infrastructure/events/event-bus-transport';
import {
  RedisStreamsEventBus,
  parseStoredBody,
  streamFeaturesFor,
  xaddArguments,
} from '../../src/infrastructure/events/redis-streams-event-bus';
import { createRedisEventBusFromEnv, positiveIntSetting } from '../../src/infrastructure/events/redis-event-bus';

test('the bus uses streams unless pubsub is asked for (ADR-0004)', () => {
  assert.equal(selectEventBusTransport(undefined), 'streams');
  assert.equal(selectEventBusTransport(''), 'streams');
  assert.equal(selectEventBusTransport('streams'), 'streams');
  assert.equal(selectEventBusTransport(' PubSub '), 'pubsub');
  assert.throws(() => selectEventBusTransport('kafka'), /EVENT_BUS_TRANSPORT/);
});

test('XADD options follow the Redis version the server reports', () => {
  const none = { ackedTrim: false, idempotentAdd: false };
  assert.deepEqual(streamFeaturesFor(undefined), none);
  assert.deepEqual(streamFeaturesFor('7.0.15'), none);
  assert.deepEqual(streamFeaturesFor('7.2.4'), none, 'Valkey reports 7.2.4');
  assert.deepEqual(streamFeaturesFor('8.0.2'), none);
  assert.deepEqual(streamFeaturesFor('8.2.0'), { ackedTrim: true, idempotentAdd: false });
  assert.deepEqual(streamFeaturesFor('8.6.1'), { ackedTrim: true, idempotentAdd: true });
  assert.deepEqual(streamFeaturesFor('8.10.3'), { ackedTrim: true, idempotentAdd: true }, 'minor 10 is newer than 6');
  assert.deepEqual(streamFeaturesFor('9.0.0'), { ackedTrim: true, idempotentAdd: true });
});

test('XADD arguments keep the order Redis requires', () => {
  const body = '{"eventId":"e1"}';
  const id = { producer: 'mp:events', id: 'e1' };
  assert.deepEqual(
    xaddArguments({ ackedTrim: false, idempotentAdd: false }, 10, body, id),
    ['MAXLEN', '~', 10, '*', 'body', body],
  );
  assert.deepEqual(
    xaddArguments({ ackedTrim: true, idempotentAdd: false }, 10, body, id),
    ['ACKED', 'MAXLEN', '~', 10, '*', 'body', body],
  );
  assert.deepEqual(
    xaddArguments({ ackedTrim: true, idempotentAdd: true }, 10, body, id),
    ['ACKED', 'IDMP', 'mp:events', 'e1', 'MAXLEN', '~', 10, '*', 'body', body],
  );
  assert.deepEqual(
    xaddArguments({ ackedTrim: true, idempotentAdd: true }, 10, body),
    ['ACKED', 'MAXLEN', '~', 10, '*', 'body', body],
    'a dead-letter replay is not deduplicated',
  );
});

test('the streams bus keeps REDIS_TLS, as the Pub/Sub bus did', async () => {
  const saved = { REDIS_TLS: process.env.REDIS_TLS, EVENT_BUS_TRANSPORT: process.env.EVENT_BUS_TRANSPORT };
  process.env.REDIS_TLS = 'true';
  delete process.env.EVENT_BUS_TRANSPORT;
  try {
    const bus = createRedisEventBusFromEnv();
    assert.ok(bus instanceof RedisStreamsEventBus);
    const client = (bus as unknown as { redis: { options: { tls?: { rejectUnauthorized?: boolean } } } }).redis;
    assert.equal(client.options.tls?.rejectUnauthorized, true, 'TLS on, certificates checked');
    await bus.close();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a refused INFO falls back to the plain XADD; any other INFO failure stops the start', async () => {
  const withInfo = (failure: Error) => {
    const bus = new RedisStreamsEventBus({ connection: {} });
    const client = (bus as unknown as { redis: { connect(): Promise<void>; info(): Promise<string> } }).redis;
    client.connect = async () => undefined;
    client.info = async () => { throw failure; };
    return bus;
  };
  const refused = withInfo(new Error("NOPERM User default has no permissions to run the 'info' command"));
  await refused.initialize();
  assert.deepEqual(refused.getStreamFeatures(), { ackedTrim: false, idempotentAdd: false });
  const renamed = withInfo(new Error("ERR unknown command 'info', with args beginning with: 'server'"));
  await renamed.initialize();
  await assert.rejects(withInfo(new Error('Connection is closed.')).initialize(), /Connection is closed/);
});

test('the bus reads only the entries it wrote', () => {
  const body = { eventId: 'e1', eventType: 'T', timestamp: '2026-11-05T00:00:00.000Z', payload: {} };
  assert.deepEqual(parseStoredBody(JSON.stringify(body)), body);
  for (const bad of [undefined, '', 'not json', '[]', 'null', '42', '{}', '{"eventId":""}', '{"eventId":"e1"}']) {
    assert.equal(parseStoredBody(bad), null, String(bad));
  }
});

test('stream size settings must be positive integers; a typo stops the start, not every publish', () => {
  assert.equal(positiveIntSetting('EVENT_BUS_STREAM_MAXLEN', undefined), undefined);
  assert.equal(positiveIntSetting('EVENT_BUS_STREAM_MAXLEN', ''), undefined);
  assert.equal(positiveIntSetting('EVENT_BUS_STREAM_MAXLEN', ' 20000 '), 20000);
  for (const bad of ['10k', '0', '-5', '1.5', 'NaN']) {
    assert.throws(() => positiveIntSetting('EVENT_BUS_STREAM_MAXLEN', bad), /EVENT_BUS_STREAM_MAXLEN must be a positive integer/, bad);
  }
});
