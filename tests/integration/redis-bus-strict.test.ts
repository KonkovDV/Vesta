import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisEventBus } from '../../src/infrastructure/events/redis-event-bus';
import { EventFactory } from '../../src/domain/events/event-store.interface';

const redisUrl = process.env.TEST_REDIS_URL;

test('strict mode fails a publish that no subscriber received', { skip: !redisUrl }, async () => {
  const parsed = new URL(redisUrl ?? 'redis://127.0.0.1:6379');
  const bus = new RedisEventBus({ connection: { host: parsed.hostname, port: Number(parsed.port || 6379) }, keyPrefix: `test-${process.pid}` });
  await bus.initialize();
  const event = EventFactory.createBaseEvent('agg-1', 'NobodyListens', { x: 1 }, 'corr_redis_strict1');
  try {
    delete process.env.EVENT_BUS_REQUIRE_SUBSCRIBER;
    await bus.publish(event);
    process.env.EVENT_BUS_REQUIRE_SUBSCRIBER = 'true';
    await assert.rejects(bus.publish(event), /No subscriber|publish/i);
  } finally {
    delete process.env.EVENT_BUS_REQUIRE_SUBSCRIBER;
    await bus.close();
  }
});
