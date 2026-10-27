import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEventBusTransport } from '../../src/infrastructure/events/event-bus-transport';

test('the bus stays on pubsub unless streams is requested', () => {
  assert.equal(selectEventBusTransport(undefined), 'pubsub');
  assert.equal(selectEventBusTransport(''), 'pubsub');
  assert.equal(selectEventBusTransport('pubsub'), 'pubsub');
  assert.equal(selectEventBusTransport('streams'), 'streams');
  assert.throws(() => selectEventBusTransport('kafka'), /EVENT_BUS_TRANSPORT/);
});
