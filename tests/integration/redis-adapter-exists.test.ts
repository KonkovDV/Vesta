/**
 * MP-K46: EXISTS with several keys returns how many exist, not which.
 * existsMany read that count as a bit mask: with a and b present it answered
 * [false, true]. Runs against a real Redis when TEST_REDIS_URL is set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisAdapter } from '../../src/infrastructure/cache/RedisAdapter';

const redisUrl = process.env.TEST_REDIS_URL;

test('existsMany answers for each key', { skip: !redisUrl }, async () => {
  const parsed = new URL(redisUrl ?? 'redis://127.0.0.1:6379');
  const adapter = new RedisAdapter({
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    keyPrefix: `exists-probe-${process.pid}:`,
    enableMetrics: false,
  });
  try {
    await adapter.set('a', '1', { ttlSeconds: 60 });
    await adapter.set('b', '1', { ttlSeconds: 60 });
    await adapter.set('d', '1', { ttlSeconds: 60 });
    assert.deepEqual(await adapter.existsMany(['a', 'b', 'missing', 'd']), [true, true, false, true]);
    assert.deepEqual(await adapter.existsMany(['missing']), [false]);
    assert.deepEqual(await adapter.existsMany([]), []);
  } finally {
    await adapter.delete('a');
    await adapter.delete('b');
    await adapter.delete('d');
    await adapter.disconnect();
  }
});
