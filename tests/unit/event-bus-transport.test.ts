import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEventBusTransport } from '../../src/infrastructure/events/event-bus-transport';
import { streamFeaturesFor, xaddArguments } from '../../src/infrastructure/events/redis-streams-event-bus';

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
